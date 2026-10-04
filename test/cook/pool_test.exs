defmodule Cook.PoolTest do
  use ExUnit.Case, async: true

  alias Cook.Pool

  test "the pool is disabled in the test environment" do
    refute Pool.enabled?()
    assert Process.whereis(Cook.Pool.Supervisor) == nil
    assert Pool.status() == %{running: false, browser_server: nil, instances: []}
  end

  test "run/2 reports that the pool is not running instead of booting anything" do
    assert Pool.run() == {:error, :pool_not_running}
    assert Pool.run(nil) == {:error, {:unknown_app, nil}}
  end

  test "the default app is the sample app with an absolute path" do
    assert Pool.default_path() == Path.expand("fixtures/sample_app")
  end

  test "agent_opts/2 takes defaults from config and lets the caller override" do
    config = [test_timeout_ms: 7_000, max_cases: 3]

    assert Pool.agent_opts([], config) == [
             tests: [],
             module_order: [],
             timeout_ms: 7_000,
             max_cases: 3,
             seed: 0,
             reload_tests: false,
             artifacts_dir: nil,
             trace: false
           ]

    opts =
      Pool.agent_opts([tests: ["a_test.exs:1"], timeout_ms: 500, max_cases: 1, seed: 9], config)

    assert opts[:tests] == ["a_test.exs:1"]
    assert opts[:timeout_ms] == 500
    assert opts[:max_cases] == 1
    assert opts[:seed] == 9
  end

  test "shape/2 measures time to first test from the request, across both nodes" do
    report = %{
      tests: [%{id: "a_test.exs:1"}],
      module_failures: [],
      counts: %{total: 1},
      seed: 0,
      compile: :noop,
      reloaded_files: [],
      known_tests: 1,
      timing: %{
        entered_at_us: 1_010_000,
        first_test_at_us: 1_050_000,
        lock_wait_ms: 0,
        compile_ms: 30,
        load_ms: 2,
        first_test_ms: 40,
        run_ms: 900,
        agent_ms: 945
      }
    }

    measured = %{
      requested_at_us: 1_000_000,
      ready_wait_ms: 5,
      total_ms: 960,
      node: :a@b,
      path: "/app"
    }

    result = Pool.shape(report, measured)

    assert result.tests == report.tests
    assert result.path == "/app"

    assert result.timing == %{
             total_ms: 960,
             ready_wait_ms: 5,
             first_test_ms: 50,
             run_ms: 900,
             compile_ms: 30,
             load_ms: 2,
             lock_wait_ms: 0,
             agent_ms: 945,
             overhead_ms: 60
           }
  end

  test "shape/2 copes with a run that started no test" do
    report = %{
      tests: [],
      module_failures: [],
      counts: %{total: 0},
      seed: 0,
      compile: :noop,
      reloaded_files: [],
      known_tests: 0,
      timing: %{
        first_test_at_us: nil,
        lock_wait_ms: 0,
        compile_ms: 1,
        load_ms: 0,
        run_ms: 0,
        agent_ms: 2
      }
    }

    measured = %{requested_at_us: 1, ready_wait_ms: 0, total_ms: 3, node: :a@b, path: "/app"}
    assert Pool.shape(report, measured).timing.first_test_ms == nil
  end
end
