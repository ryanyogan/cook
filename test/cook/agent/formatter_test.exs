defmodule Cook.Agent.FormatterTest do
  use ExUnit.Case, async: true

  alias Cook.Agent.Formatter

  @file_path Path.relative_to_cwd(__ENV__.file)

  defp test_struct(attrs) do
    struct!(
      %ExUnit.Test{
        name: :"test signs in",
        module: MyApp.LoginTest,
        time: 12_600,
        tags: %{file: Path.expand(@file_path), line: 4}
      },
      attrs
    )
  end

  defp failed(line) do
    stack = [
      {PhoenixTest, :assert_has, 3, [file: ~c"lib/phoenix_test.ex", line: 10]},
      {MyApp.LoginTest, :"test signs in", 1, [file: String.to_charlist(@file_path), line: line]}
    ]

    test_struct(state: {:failed, [{:error, %RuntimeError{message: "boom"}, stack}]})
  end

  test "status/1 maps ExUnit states" do
    assert Formatter.status(nil) == :passed
    assert Formatter.status({:failed, []}) == :failed
    assert Formatter.status({:skipped, "why"}) == :skipped
    assert Formatter.status({:excluded, "why"}) == :excluded
    assert Formatter.status({:invalid, MyApp.LoginTest}) == :invalid
  end

  test "result/2 for a passing test" do
    assert %{
             id: @file_path <> ":4",
             file: @file_path,
             line: 4,
             module: "MyApp.LoginTest",
             name: "test signs in",
             status: :passed,
             duration_us: 12_600,
             duration_ms: 13,
             started_at_us: 99,
             failure: nil,
             logs: ""
           } = Formatter.result(test_struct([]), 99)
  end

  test "result/2 for a failing test points at the step in the test file" do
    # the line below is what the fake stacktrace refers to
    line = __ENV__.line - 1
    result = Formatter.result(failed(line))

    assert result.status == :failed
    assert result.failure.message == "boom"
    assert result.failure.timed_out == false
    assert result.failure.step_line == line
    assert result.failure.step == "# the line below is what the fake stacktrace refers to"
    assert result.failure.formatted =~ "boom"

    assert [%{module: "PhoenixTest", function: "assert_has/3", line: 10}, %{file: @file_path}] =
             result.failure.stacktrace
  end

  test "result/2 flags a test that hit the time cap" do
    timeout = ExUnit.TimeoutError.exception(timeout: 10_000, type: "test")
    result = Formatter.result(test_struct(state: {:failed, [{:error, timeout, []}]}))

    assert result.failure.timed_out
    assert result.failure.message =~ "timed out after 10000ms"
    assert result.failure.step == nil
  end

  test "result/2 for a test whose module setup failed" do
    result = Formatter.result(test_struct(state: {:invalid, MyApp.LoginTest}, time: 0))

    assert result.status == :invalid
    assert result.failure.message =~ "setup_all failed"
  end

  test "collects events and reports when the suite finishes" do
    ref = make_ref()

    pid =
      start_supervised!(%{
        id: Formatter,
        start: {GenServer, :start_link, [Formatter, [cook_report_to: self(), cook_run_ref: ref]]}
      })

    passed = test_struct([])
    excluded = test_struct(name: :"test other", state: {:excluded, "filtered"}, time: 0)

    broken = %ExUnit.TestModule{
      name: MyApp.BrokenTest,
      file: Path.expand(@file_path),
      state: {:failed, [{:error, %RuntimeError{message: "no setup"}, []}]}
    }

    GenServer.cast(pid, {:suite_started, []})
    GenServer.cast(pid, {:test_started, passed})
    GenServer.cast(pid, {:test_finished, passed})
    GenServer.cast(pid, {:test_finished, excluded})
    GenServer.cast(pid, {:module_finished, broken})
    GenServer.cast(pid, {:suite_finished, %{run: 5_000, async: nil, load: nil}})

    assert_receive {:cook_report, ^ref, report}
    assert [%{name: "test signs in", status: :passed, started_at_us: started}] = report.tests
    assert report.first_test_at_us == started
    assert report.excluded == 1
    assert report.run_us == 5_000
    assert [%{module: "MyApp.BrokenTest", message: "no setup"}] = report.module_failures
  end
end
