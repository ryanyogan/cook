defmodule Cook.PoolStub do
  @moduledoc """
  Stands in for `Cook.Pool` in tests: no browser, no app instance.

  `put/1` sets what `run/2` does (a function of `path, opts`) for the calling
  test; use only in `async: false` tests.
  """

  @path "/apps/sample"

  def put(fun), do: Application.put_env(:cook, __MODULE__, fun)
  def default_path, do: @path

  @doc """
  Overrides fields of the browser server in `status/0`, e.g. `%{accepting: false}`.
  """
  def put_browser(fields), do: Application.put_env(:cook, :pool_stub_browser, fields)

  def status do
    %{
      running: true,
      browser_server:
        Map.merge(
          %{status: :ready, port: 4041, os_pid: 1},
          Application.get_env(:cook, :pool_stub_browser, %{})
        ),
      instances: [%{path: @path, status: :ready, node: :stub@host, http_port: 4100}]
    }
  end

  def run(path, opts), do: Application.fetch_env!(:cook, __MODULE__).(path, opts)

  @doc """
  A raw result shaped like `Cook.Pool.run/2`'s, from `{id, status, duration_ms}` tuples.
  """
  def raw(tests, extra \\ %{}) do
    tests =
      for {{id, status, duration_ms}, index} <- Enum.with_index(tests) do
        [file, line] = String.split(id, ":")

        %{
          id: id,
          file: file,
          line: String.to_integer(line),
          module: file |> Path.basename(".exs") |> Macro.camelize(),
          name: "test #{id}",
          status: status,
          duration_ms: duration_ms,
          started_at_us: 1_000_000 + index * 1000,
          logs: "",
          failure:
            if status == :failed do
              %{
                message: "\n\nexpected to see X\n",
                timed_out: false,
                step: "assert_has(\"#x\")",
                step_line: 3
              }
            end
        }
      end

    Map.merge(
      %{
        tests: tests,
        module_failures: [],
        counts: %{total: length(tests), excluded: 0},
        known_test_count: length(tests),
        seed: 0,
        timing: %{run_ms: 100, first_test_ms: 5, ready_wait_ms: 0, compile_ms: 1, load_ms: 0}
      },
      extra
    )
  end
end
