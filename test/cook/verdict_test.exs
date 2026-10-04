defmodule Cook.VerdictTest do
  use ExUnit.Case, async: true

  alias Cook.PoolStub
  alias Cook.Verdict

  @context %{
    run_id: "r1",
    path: "/apps/sample",
    tests: [],
    cap_ms: 10_000,
    duration_ms: 130,
    queue_ms: 2,
    wait_ms: 3
  }

  test "a passing run has the spec's keys and timings" do
    raw = PoolStub.raw([{"test/a_test.exs:3", :passed, 40}, {"test/b_test.exs:5", :passed, 90}])
    verdict = Verdict.build({:ok, raw}, @context)

    assert verdict.schema == "cook.verdict/1"
    assert verdict.schema == Verdict.schema()
    assert verdict.status == "pass"
    assert verdict.duration_ms == 130
    assert verdict.timing.tests_ms == 100
    assert verdict.timing.overhead_ms == 30
    assert verdict.timing.slowest_test_ms == 90
    assert verdict.timing.first_test_ms == 8
    assert {verdict.selected, verdict.skipped, verdict.selection_reason} == {2, 0, "all"}
    assert verdict.failures == []
    assert verdict.quarantined == []
    assert verdict.error == nil
    assert Verdict.exit_code(verdict) == 0

    for key <-
          ~w(schema status duration_ms timing selected skipped selection_reason failures quarantined)a do
      assert Map.has_key?(verdict, key)
    end
  end

  test "a failing test is reported once with step, message and repro" do
    raw = PoolStub.raw([{"test/a_test.exs:3", :failed, 40}, {"test/b_test.exs:5", :passed, 90}])
    verdict = Verdict.build({:ok, raw}, @context)

    assert verdict.status == "fail"
    assert Verdict.exit_code(verdict) == 1
    assert verdict.counts == %{passed: 1, failed: 1, known: 2}
    assert [failure] = verdict.failures
    assert failure.test == "test/a_test.exs:3"
    assert failure.step == "assert_has(\"#x\")"
    assert failure.message == "expected to see X"
    assert failure.repro == "cook run /apps/sample test/a_test.exs:3"
    assert failure.kind == "assertion"

    assert {failure.dom_snapshot, failure.console_errors, failure.server_logs, failure.trace} ==
             {nil, [], [], nil}
  end

  test "failure artifacts from the pool end up in the failure" do
    raw = PoolStub.raw([{"test/a_test.exs:3", :failed, 40}])

    artifacts = %{
      dom_snapshot: "/art/a_test_3.html",
      console_errors: ["boom"],
      server_logs: ["[error] x"],
      trace: "/art/a_test_3.zip"
    }

    raw = %{raw | tests: Enum.map(raw.tests, &Map.put(&1, :artifacts, artifacts))}

    assert [failure] = Verdict.build({:ok, raw}, @context).failures
    assert failure.dom_snapshot == "/art/a_test_3.html"
    assert failure.console_errors == ["boom"]
    assert failure.server_logs == ["[error] x"]
    assert failure.trace == "/art/a_test_3.zip"
  end

  test "a test over the cap fails with a split message even if ExUnit let it pass" do
    raw =
      PoolStub.raw([
        {"test/slow_test.exs:3", :passed, 12_000},
        {"test/b_test.exs:5", :passed, 10_000}
      ])

    verdict = Verdict.build({:ok, raw}, @context)

    assert verdict.status == "fail"
    assert [failure] = verdict.failures
    assert failure.test == "test/slow_test.exs:3"
    assert failure.kind == "cap"
    assert failure.message =~ "12000 ms"
    assert failure.message =~ "cap of 10000 ms"
    assert failure.message =~ "Split this test"
    assert [%{status: "failed"}, %{status: "passed"}] = Verdict.test_rows(raw, 10_000)
  end

  test "a test ExUnit stopped at the cap gets the split message" do
    raw = PoolStub.raw([{"test/slow_test.exs:3", :failed, 10_001}])
    raw = %{raw | tests: Enum.map(raw.tests, &put_in(&1.failure.timed_out, true))}

    assert [%{kind: "cap", message: message}] = Verdict.build({:ok, raw}, @context).failures
    assert message =~ "Split this test"
  end

  test "an explicit selection counts the tests that did not run as skipped" do
    raw = PoolStub.raw([{"test/a_test.exs:3", :passed, 40}], %{known_test_count: 44})
    verdict = Verdict.build({:ok, raw}, %{@context | tests: ["test/a_test.exs:3"]})

    assert {verdict.selected, verdict.skipped, verdict.selection_reason} == {1, 43, "explicit"}
  end

  test "a setup_all failure fails every test of the module with its message" do
    raw = PoolStub.raw([{"test/a_test.exs:3", :invalid, 0}])

    raw = %{
      raw
      | module_failures: [%{module: "ATest", file: "test/a_test.exs", message: "no db"}]
    }

    assert [%{kind: "setup_all", message: message}] = Verdict.build({:ok, raw}, @context).failures
    assert message =~ "no db"
  end

  test "pool errors become error verdicts with a reason" do
    for {reason, name} <- [
          {{:instance_down, :noconnection}, "app_instance_down"},
          {{:browser_server_down, :killed}, "browser_server_down"},
          {{:unknown_tests, ["x_test.exs"]}, "unknown_tests"},
          {{:compile_failed, [%{file: "lib/a.ex", line: 3, message: "undefined"}]},
           "compile_failed"},
          {:pool_not_running, "pool_not_running"},
          {:something_else, "unexpected"}
        ] do
      verdict = Verdict.build({:error, reason}, @context)
      assert verdict.status == "error"
      assert verdict.error.reason == name
      assert is_binary(verdict.error.message)
      assert verdict.failures == []
      assert Verdict.exit_code(verdict) == 2
    end
  end

  test "to_json/1 starts with the schema and round-trips" do
    raw = PoolStub.raw([{"test/a_test.exs:3", :failed, 40}])
    json = {:ok, raw} |> Verdict.build(@context) |> Verdict.to_json() |> IO.iodata_to_binary()

    assert String.starts_with?(json, ~s({"schema":"cook.verdict/1","run_id":"r1","status":"fail"))

    assert %{
             "failures" => [%{"test" => "test/a_test.exs:3"}],
             "timing" => %{"first_test_ms" => 8}
           } = Jason.decode!(json)
  end

  test "summary/1 is short and names failures and errors" do
    raw = PoolStub.raw([{"test/a_test.exs:3", :failed, 40}, {"test/b_test.exs:5", :passed, 90}])
    text = {:ok, raw} |> Verdict.build(@context) |> Verdict.summary()
    assert text =~ "FAIL   1 of 2 tests failed"
    assert text =~ "repro:   cook run /apps/sample test/a_test.exs:3"

    assert {:ok, PoolStub.raw([{"test/b_test.exs:5", :passed, 90}])}
           |> Verdict.build(@context)
           |> Verdict.summary() =~ "PASS   1 tests"

    assert {:error, {:instance_down, :noconnection}}
           |> Verdict.build(@context)
           |> Verdict.summary() =~ "ERROR  app_instance_down"
  end
end
