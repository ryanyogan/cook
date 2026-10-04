defmodule Cook.RunsTest do
  use Cook.DataCase, async: false

  alias Cook.PoolStub
  alias Cook.Runs
  alias Cook.Runs.Runner

  @path PoolStub.default_path()

  defp record(tests) do
    raw = PoolStub.raw(tests)

    context = %{
      run_id: Runner.new_run_id(),
      path: @path,
      tests: [],
      cap_ms: 10_000,
      duration_ms: 1,
      queue_ms: 0,
      wait_ms: 0
    }

    verdict = Cook.Verdict.build({:ok, raw}, context)
    {:ok, run} = Runs.record(verdict, Cook.Verdict.test_rows(raw, 10_000))
    run
  end

  test "record/2 stores the run and one row per test" do
    run = record([{"test/a_test.exs:3", :failed, 40}, {"test/b_test.exs:5", :passed, 90}])

    assert run.status == "fail"
    assert {run.selected, run.passed, run.failed} == {2, 1, 1}

    assert [
             %{test_id: "test/a_test.exs:3", status: "failed", duration_ms: 40, started_ms: 0},
             %{status: "passed", started_ms: 1}
           ] =
             Cook.Repo.all(
               from t in Cook.Runs.TestResult, where: t.run_id == ^run.id, order_by: t.id
             )
  end

  test "module_order/1 uses each test's latest duration, longest module first" do
    assert Runs.module_order(@path) == []

    record([
      {"test/a_test.exs:3", :passed, 500},
      {"test/b_test.exs:5", :passed, 90},
      {"test/b_test.exs:9", :passed, 90}
    ])

    assert Runs.module_order(@path) == ["ATest", "BTest"]

    record([{"test/a_test.exs:3", :passed, 100}])
    assert Runs.module_order(@path) == ["BTest", "ATest"]
    assert Runs.module_order("/other/app") == []
  end

  test "normalize_tests/2 makes absolute references relative to the app" do
    assert Runs.normalize_tests("/apps/sample", [
             "/apps/sample/test/a_test.exs:3",
             "test/b_test.exs",
             " ",
             "/else/c_test.exs"
           ]) ==
             ["test/a_test.exs:3", "test/b_test.exs", "/else/c_test.exs"]
  end

  test "readiness/2 says whether to run, wait or give up" do
    status = PoolStub.status()
    assert Runner.readiness(status, @path) == :ready
    assert Runner.readiness(%{status | browser_server: nil}, @path) == :wait

    assert Runner.readiness(%{status | instances: [%{path: @path, status: :booting}]}, @path) ==
             :wait

    assert Runner.readiness(status, "/other") == {:error, {:unknown_app, "/other"}}

    assert Runner.readiness(%{running: false, browser_server: nil, instances: []}, @path) ==
             {:error, :pool_not_running}
  end

  test "a run goes to the pool with the cap and the recorded order, and is stored" do
    record([{"test/a_test.exs:3", :passed, 500}, {"test/b_test.exs:5", :passed, 900}])
    test_pid = self()

    PoolStub.put(fn path, opts ->
      send(test_pid, {:pool_run, path, opts})
      {:ok, PoolStub.raw([{"test/a_test.exs:3", :passed, 40}], %{known_test_count: 2})}
    end)

    verdict = Runs.run(nil, ["test/a_test.exs:3"])

    assert_received {:pool_run, @path, opts}
    assert opts[:tests] == ["test/a_test.exs:3"]
    assert opts[:module_order] == ["BTest", "ATest"]
    assert opts[:timeout_ms] == 10_000
    assert {verdict.status, verdict.selected, verdict.skipped} == {"pass", 1, 1}
    assert [%{public_id: id, status: "pass"} | _older] = Runs.recent(5)
    assert id == verdict.run_id
  end

  test "the browser server dying mid-run is an error verdict, not a hang" do
    browser = spawn(fn -> Process.sleep(:infinity) end)
    test_pid = self()

    PoolStub.put(fn _path, _opts ->
      send(test_pid, :pool_running)
      Process.sleep(:infinity)
    end)

    run = Task.async(fn -> Runs.run(nil, [], browser_server: browser) end)
    assert_receive :pool_running
    Process.exit(browser, :kill)

    verdict = Task.await(run)
    assert verdict.status == "error"
    assert verdict.error.reason == "browser_server_down"
    assert [%{status: "error", error: "browser_server_down"} | _older] = Runs.recent(1)
  end

  test "a pool error and a pool that never gets ready are error verdicts" do
    PoolStub.put(fn _path, _opts -> {:error, {:instance_down, :noconnection}} end)
    assert Runs.run().error.reason == "app_instance_down"
    assert Runs.run("/not/configured").error.reason == "unknown_app"
  end
end
