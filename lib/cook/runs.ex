defmodule Cook.Runs do
  @moduledoc """
  Running tests on the warm pool and remembering what happened.

  `run/3` is what the HTTP API calls: it queues behind other runs of the same
  app, runs on the pool and always returns a verdict (`Cook.Verdict`), never an
  error tuple and never a crash. Every run and every test result is stored in
  `Cook.Repo`; recorded durations order the next run longest-first.
  """

  import Ecto.Query

  alias Cook.Repo
  alias Cook.Runs.Coordinator
  alias Cook.Runs.Ordering
  alias Cook.Runs.Run
  alias Cook.Runs.TestResult

  @history_runs 50

  @doc """
  Configuration (`config :cook, Cook.Runs, ...`): `:pool` (module with
  `run/2`, `status/0`, `default_path/0`), `:artifacts_dir`, `:keep_artifact_runs`,
  `:ready_timeout_ms`.
  """
  def config, do: Application.get_env(:cook, __MODULE__, [])

  @doc """
  The pool module runs go to.
  """
  def pool, do: Keyword.get(config(), :pool, Cook.Pool)

  @doc """
  Runs `tests` (`"file"`, `"file:line"` or `"dir"`; `[]` for all) of the app at
  `path` (`nil` for the default app) and returns the verdict.
  """
  def run(path \\ nil, tests \\ [], opts \\ []) do
    path = Path.expand(path || pool().default_path() || ".")

    Coordinator.run(%{
      path: path,
      tests: normalize_tests(path, tests),
      opts: opts,
      received_at: System.monotonic_time(:millisecond)
    })
  end

  @doc """
  A JSON-friendly snapshot: pool readiness, running and queued runs, last run.
  """
  def status do
    pool = pool().status()

    %{
      schema: Cook.Verdict.schema(),
      ready: pool_ready?(pool),
      pool: %{
        running: pool.running,
        browser_server:
          pool.browser_server &&
            %{
              status: status_text(pool.browser_server[:status]),
              port: pool.browser_server[:port],
              os_pid: pool.browser_server[:os_pid]
            },
        instances:
          for instance <- pool.instances do
            %{
              path: instance[:path],
              status: status_text(instance[:status]),
              node: instance[:node] && to_string(instance[:node]),
              http_port: instance[:http_port]
            }
          end
      },
      runs: Coordinator.info(),
      last_run: last_run()
    }
  end

  defp pool_ready?(%{
         running: true,
         browser_server: %{status: :ready},
         instances: [_ | _] = instances
       }) do
    Enum.all?(instances, &(&1[:status] == :ready))
  end

  defp pool_ready?(_pool), do: false

  defp status_text(status) when is_atom(status), do: Atom.to_string(status)
  defp status_text({:down, _reason}), do: "down"
  defp status_text(other), do: inspect(other)

  defp last_run do
    case recent(1) do
      [run] ->
        %{
          run_id: run.public_id,
          status: run.status,
          duration_ms: run.duration_ms,
          at: run.inserted_at
        }

      [] ->
        nil
    end
  rescue
    _error -> nil
  end

  @doc """
  Makes test references relative to the app root: an absolute path below `path`
  loses that prefix, anything else is kept.
  """
  def normalize_tests(path, tests) do
    for test <- tests, test = String.trim(test), test != "" do
      case Path.type(test) do
        :absolute -> Path.relative_to(test, path)
        _other -> test
      end
    end
  end

  @doc """
  Stores a run with its test rows (`Cook.Verdict.test_rows/2`).
  """
  def record(verdict, rows) do
    Repo.transaction(fn ->
      run =
        Repo.insert!(%Run{
          public_id: verdict.run_id,
          path: verdict.path,
          status: verdict.status,
          selection_reason: verdict.selection_reason,
          selected: verdict.selected,
          skipped: verdict.skipped,
          passed: verdict.counts.passed,
          failed: verdict.counts.failed,
          duration_ms: verdict.duration_ms,
          overhead_ms: verdict.timing.overhead_ms,
          tests_ms: verdict.timing.tests_ms,
          slowest_test_ms: verdict.timing.slowest_test_ms,
          first_test_ms: verdict.timing.first_test_ms,
          error: verdict.error && verdict.error.reason,
          verdict: verdict
        })

      now = DateTime.utc_now()

      entries =
        for row <- rows do
          Map.merge(row, %{run_id: run.id, path: verdict.path, inserted_at: now})
        end

      Repo.insert_all(TestResult, entries)
      run
    end)
  end

  @doc """
  Module names of the app at `path`, longest recorded total duration first.
  Uses each test's most recent result from the last #{@history_runs} runs.
  """
  def module_order(path) do
    path |> recent_durations() |> Ordering.module_order()
  end

  @doc """
  The most recent duration of every test of the app at `path`.
  """
  def recent_durations(path) do
    recent_runs =
      from r in Run, where: r.path == ^path, order_by: [desc: r.id], limit: @history_runs

    Repo.all(
      from t in TestResult,
        join: r in subquery(recent_runs),
        on: r.id == t.run_id,
        where: t.status in ["passed", "failed"],
        distinct: [t.module, t.name],
        order_by: [t.module, t.name, desc: t.id],
        select: %{module: t.module, test_id: t.test_id, duration_ms: t.duration_ms}
    )
  end

  @doc """
  The latest runs, newest first.
  """
  def recent(limit \\ 10) do
    Repo.all(from r in Run, order_by: [desc: r.id], limit: ^limit)
  end
end
