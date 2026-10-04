defmodule Cook.Pool do
  @moduledoc """
  The warm pool: a Playwright browser server and one warm instance per target app.

  `run/2` is the entry point for running tests. It never boots anything: it waits
  (bounded) for the instance to be ready and asks the agent inside it to run.
  """

  alias Cook.Pool.AppInstance
  alias Cook.Pool.BrowserServer

  @ready_timeout_ms 120_000
  @run_timeout_ms 600_000
  @retry_ms 50

  @doc """
  Pool configuration (`config :cook, Cook.Pool, ...`).
  """
  def config, do: Application.get_env(:cook, __MODULE__, [])

  @doc """
  Whether the pool starts with the application.
  """
  def enabled?, do: Keyword.get(config(), :enabled, false)

  @doc """
  Absolute paths of the configured target apps. The first one is the default.
  """
  def app_paths do
    for app <- Keyword.get(config(), :apps, []), do: app |> Keyword.fetch!(:path) |> Path.expand()
  end

  @doc """
  The default target app path, or `nil` when none is configured.
  """
  def default_path, do: List.first(app_paths())

  @doc """
  Runs tests of the app at `path` on its warm instance.

  Options:
    * `:tests` - list of `"file"`, `"file:line"` or `"dir"` relative to the app
      root; empty (default) runs every loaded test
    * `:module_order` - module names as strings (`"MyAppWeb.LoginTest"`); those
      modules start first, in this order
    * `:timeout_ms` - per-test cap, default from config (`:test_timeout_ms`)
    * `:max_cases` - test modules running at once, default from config
    * `:seed` - ExUnit seed, default `0` (no shuffling)
    * `:reload_tests` - reload all test files instead of only changed ones
    * `:artifacts_dir` - absolute directory for this run's failure artifacts; failed
      tests then carry `artifacts: %{dom_snapshot, console_errors, server_logs, trace, tracked}`
    * `:trace` - record Playwright traces (default from config `:trace`, false)
    * `:ready_timeout_ms` - how long to wait for a booting instance (default #{@ready_timeout_ms})
    * `:run_timeout_ms` - limit for the whole run (default #{@run_timeout_ms})

  Returns `{:ok, result}` (see `shape/2`) or `{:error, reason}`. Failing tests
  are an `:ok` result; `:error` means the run itself could not complete:

    * `{:unknown_app, path}` / `:pool_not_running`
    * `{:not_ready, status}` - the instance did not become ready in time
    * `{:compile_failed, diagnostics}` / `{:test_load_failed, diagnostics}`
    * `{:unknown_tests, refs}`
    * `{:instance_down, reason}` - the instance died or was restarted mid-run
    * `{:run_timeout, ms}` / `{:agent_crashed, text}`
  """
  def run(path \\ default_path(), opts \\ []) do
    requested_at_us = System.system_time(:microsecond)
    started = System.monotonic_time(:millisecond)

    with {:ok, instance} <- lookup(path),
         ready_timeout = Keyword.get(opts, :ready_timeout_ms, @ready_timeout_ms),
         deadline = started + ready_timeout,
         {:ok, ready} <- await_ready(instance, deadline),
         ready_wait_ms = System.monotonic_time(:millisecond) - started,
         run_timeout = Keyword.get(opts, :run_timeout_ms, @run_timeout_ms),
         {:ok, report} <- call_agent(ready.node, agent_opts(opts, config()), run_timeout) do
      {:ok,
       shape(report, %{
         requested_at_us: requested_at_us,
         ready_wait_ms: ready_wait_ms,
         total_ms: System.monotonic_time(:millisecond) - started,
         node: ready.node,
         path: Path.expand(path)
       })}
    end
  end

  @doc """
  Status of the pool without waiting: the browser server and every instance.
  """
  def status do
    if Process.whereis(Cook.Pool.Supervisor) do
      %{
        running: true,
        browser_server: safe(fn -> BrowserServer.status() end),
        instances:
          for path <- app_paths() do
            safe(fn -> AppInstance.status(AppInstance.via(path)) end) ||
              %{path: path, status: :down}
          end
      }
    else
      %{running: false, browser_server: nil, instances: []}
    end
  end

  @doc """
  Options passed to `Cook.Agent.run/1`, with defaults taken from `config`.
  """
  def agent_opts(opts, config) do
    [
      tests: Keyword.get(opts, :tests, []),
      module_order: Keyword.get(opts, :module_order, []),
      timeout_ms: opts[:timeout_ms] || Keyword.get(config, :test_timeout_ms, 10_000),
      max_cases: opts[:max_cases] || Keyword.get(config, :max_cases, 8),
      seed: Keyword.get(opts, :seed, 0),
      reload_tests: Keyword.get(opts, :reload_tests, false),
      artifacts_dir: Keyword.get(opts, :artifacts_dir),
      trace: Keyword.get(opts, :trace, Keyword.get(config, :trace, false))
    ]
  end

  @doc """
  Combines the agent's report with what the daemon measured.

  Result:

      %{
        path: app path, node: instance node, seed: integer,
        tests: [%{id, file, line, module, name, status, duration_ms, duration_us,
                  started_at_us, failure, logs}],
        module_failures: [%{module, file, message}],
        counts: %{total, passed, failed, invalid, skipped, excluded},
        known_tests: number of loaded test files,
        compile: :noop | :ok, reloaded_files: [file],
        timing: %{
          total_ms:       wall time of `run/2`,
          ready_wait_ms:  waiting for the instance to be ready (0 when warm),
          first_test_ms:  from the `run/2` call to the first test starting (nil if none ran),
          run_ms:         ExUnit's run time,
          compile_ms:     in-VM recompile, load_ms: reloading test files,
          lock_wait_ms:   waiting for another run on the instance,
          agent_ms:       time spent inside the instance,
          overhead_ms:    total_ms - run_ms
        }
      }
  """
  def shape(report, measured) do
    agent = report.timing

    first_test_ms =
      agent.first_test_at_us && div(agent.first_test_at_us - measured.requested_at_us + 500, 1000)

    %{
      path: measured.path,
      node: measured.node,
      seed: report.seed,
      tests: report.tests,
      module_failures: report.module_failures,
      counts: report.counts,
      known_tests: report.known_tests,
      known_test_count: Map.get(report, :known_test_count),
      compile: report.compile,
      reloaded_files: report.reloaded_files,
      timing: %{
        total_ms: measured.total_ms,
        ready_wait_ms: measured.ready_wait_ms,
        first_test_ms: first_test_ms,
        run_ms: agent.run_ms,
        compile_ms: agent.compile_ms,
        load_ms: agent.load_ms,
        lock_wait_ms: agent.lock_wait_ms,
        agent_ms: agent.agent_ms,
        overhead_ms: measured.total_ms - (agent.run_ms || 0)
      }
    }
  end

  defp lookup(nil), do: {:error, {:unknown_app, nil}}

  defp lookup(path) do
    path = Path.expand(path)

    cond do
      Process.whereis(Cook.Pool.Registry) == nil -> {:error, :pool_not_running}
      path in app_paths() -> {:ok, AppInstance.via(path)}
      true -> {:error, {:unknown_app, path}}
    end
  end

  # While the supervisor restarts the pool the instance process is briefly gone;
  # that is "not ready yet", so keep trying until the deadline.
  defp await_ready(instance, deadline) do
    remaining = deadline - System.monotonic_time(:millisecond)

    try do
      AppInstance.await_ready(instance, max(remaining, 0))
    catch
      :exit, reason ->
        if remaining > 0 do
          Process.sleep(@retry_ms)
          await_ready(instance, deadline)
        else
          {:error, {:not_ready, {:instance_unavailable, exit_reason(reason)}}}
        end
    end
  end

  defp call_agent(node, agent_opts, timeout) do
    :erpc.call(node, Cook.Agent, :run, [agent_opts], timeout)
  catch
    :error, {:erpc, :timeout} -> {:error, {:run_timeout, timeout}}
    :error, {:erpc, reason} -> {:error, {:instance_down, reason}}
    kind, reason -> {:error, {:instance_down, {kind, reason}}}
  end

  defp exit_reason({reason, {GenServer, :call, _args}}), do: reason
  defp exit_reason(reason), do: reason

  defp safe(fun) do
    fun.()
  catch
    :exit, _reason -> nil
  end
end
