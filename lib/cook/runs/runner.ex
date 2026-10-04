defmodule Cook.Runs.Runner do
  @moduledoc """
  Executes one run and returns its verdict. Called by `Cook.Runs.Coordinator`,
  one at a time per app.

  The runner waits (bounded) for the pool to be ready, then watches the browser
  server while the pool runs the tests. If the browser server or the app
  instance dies, the run is abandoned and the verdict is an `error`. Nothing is
  retried.
  """

  require Logger

  alias Cook.Runs
  alias Cook.Verdict

  @poll_ms 20
  @ready_timeout_ms 120_000
  @keep_artifact_runs 20

  @doc """
  `request`: `%{path, tests, opts, received_at}` (`received_at` in monotonic ms).

  Options in `request.opts`: anything `Cook.Pool.run/2` takes, plus
  `:ready_timeout_ms` and `:browser_server` (pid to watch; default: the pool's).
  """
  def run(request) do
    pool = Runs.pool()
    config = Runs.config()
    run_id = new_run_id()
    started = System.monotonic_time(:millisecond)
    queue_ms = started - request.received_at

    cap_ms =
      request.opts[:timeout_ms] || Keyword.get(Cook.Pool.config(), :test_timeout_ms, 10_000)

    artifacts_dir = artifacts_dir(config, run_id)

    ready_timeout =
      request.opts[:ready_timeout_ms] || config[:ready_timeout_ms] || @ready_timeout_ms

    {result, wait_ms} =
      case await_pool(pool, request.path, started + ready_timeout) do
        :ok ->
          wait_ms = System.monotonic_time(:millisecond) - request.received_at

          pool_opts =
            request.opts
            |> Keyword.drop([:ready_timeout_ms, :browser_server])
            |> Keyword.merge(
              tests: request.tests,
              module_order: module_order(request.path),
              timeout_ms: cap_ms,
              artifacts_dir: artifacts_dir
            )

          {watched_run(pool, request.path, pool_opts, browser_server(request.opts)), wait_ms}

        {:error, _reason} = error ->
          {error, System.monotonic_time(:millisecond) - request.received_at}
      end

    verdict =
      Verdict.build(result, %{
        run_id: run_id,
        path: request.path,
        tests: request.tests,
        cap_ms: cap_ms,
        queue_ms: queue_ms,
        wait_ms: wait_ms,
        duration_ms: System.monotonic_time(:millisecond) - request.received_at
      })

    rows =
      case result do
        {:ok, raw} -> Verdict.test_rows(raw, cap_ms)
        {:error, _reason} -> discard_artifacts(artifacts_dir)
      end

    persist(verdict, rows)
    prune_artifacts(config)
    verdict
  end

  @doc """
  A run id that sorts by time: `"20261004T160501_3fa9"`.
  """
  def new_run_id do
    time = Calendar.strftime(DateTime.utc_now(), "%Y%m%dT%H%M%S")
    "#{time}_#{Base.encode16(:crypto.strong_rand_bytes(2), case: :lower)}"
  end

  @doc """
  Whether a pool status says the pool can run tests of `path` right now.
  Returns `:ready`, `:wait` or `{:error, reason}` when waiting cannot help.
  """
  def readiness(%{running: false}, _path), do: {:error, :pool_not_running}

  def readiness(%{instances: instances} = status, path) do
    instance = Enum.find(instances, &(&1[:path] == path))

    cond do
      instance == nil -> {:error, {:unknown_app, path}}
      match?(%{status: :ready}, status[:browser_server]) and instance.status == :ready -> :ready
      true -> :wait
    end
  end

  # A run that arrives while the pool is restarting waits here, bounded.
  defp await_pool(pool, path, deadline) do
    status = pool.status()

    case readiness(status, path) do
      :ready ->
        :ok

      {:error, _reason} = error ->
        error

      :wait ->
        if System.monotonic_time(:millisecond) < deadline do
          Process.sleep(@poll_ms)
          await_pool(pool, path, deadline)
        else
          {:error, {:not_ready, summarize(status)}}
        end
    end
  end

  defp summarize(status) do
    %{
      browser_server: status[:browser_server] && status.browser_server[:status],
      instances: for(instance <- status.instances, do: {instance[:path], instance[:status]})
    }
  end

  defp watched_run(pool, path, pool_opts, browser_server) do
    task =
      Task.Supervisor.async_nolink(Cook.Runs.TaskSupervisor, fn -> pool.run(path, pool_opts) end)

    watch = browser_server && Process.monitor(browser_server)
    task_ref = task.ref

    result =
      receive do
        {^task_ref, result} ->
          Process.demonitor(task_ref, [:flush])
          result

        {:DOWN, ^task_ref, :process, _pid, reason} ->
          {:error, {:runner_crashed, Exception.format_exit(reason)}}

        {:DOWN, ^watch, :process, _pid, reason} when watch != nil ->
          _ = Task.Supervisor.terminate_child(Cook.Runs.TaskSupervisor, task.pid)
          Process.demonitor(task_ref, [:flush])
          {:error, {:browser_server_down, reason}}
      end

    if watch, do: Process.demonitor(watch, [:flush])
    result
  end

  defp browser_server(opts) do
    Keyword.get_lazy(opts, :browser_server, fn -> Process.whereis(Cook.Pool.BrowserServer) end)
  end

  # Without history the pool keeps its own order. A broken database must not
  # break a run.
  defp module_order(path) do
    Runs.module_order(path)
  rescue
    error ->
      Logger.warning("cook: could not read recorded durations: #{Exception.message(error)}")
      []
  end

  defp persist(verdict, rows) do
    case Runs.record(verdict, rows) do
      {:ok, _run} -> :ok
      {:error, reason} -> Logger.warning("cook: could not store run: #{inspect(reason)}")
    end
  rescue
    error -> Logger.warning("cook: could not store run: #{Exception.message(error)}")
  end

  defp artifacts_dir(config, run_id) do
    case config[:artifacts_dir] do
      nil -> nil
      root -> Path.join(Path.expand(root), "run_#{run_id}")
    end
  end

  # An abandoned run leaves the snapshots of tests that had finished; nothing
  # in the verdict points at them.
  defp discard_artifacts(nil), do: []

  defp discard_artifacts(dir) do
    _ = File.rm_rf(dir)
    []
  end

  # Run ids sort by time, so the oldest artifact directories are first.
  defp prune_artifacts(config) do
    with root when is_binary(root) <- config[:artifacts_dir],
         {:ok, entries} <- File.ls(root) do
      keep = config[:keep_artifact_runs] || @keep_artifact_runs

      entries
      |> Enum.filter(&String.starts_with?(&1, "run_"))
      |> Enum.sort(:desc)
      |> Enum.drop(keep)
      |> Enum.each(&File.rm_rf(Path.join(root, &1)))
    end

    :ok
  end
end
