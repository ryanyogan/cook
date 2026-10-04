defmodule Cook.Agent.TrackerTest do
  use ExUnit.Case, async: true

  alias Cook.Agent.Tracker

  test "artifact names come from the test's file and line" do
    assert Tracker.file_name(%{file: "/app/test/features/checkout_test.exs", line: 42}) ==
             "checkout_test_42"
  end

  test "track/1 does nothing outside a Cook run" do
    assert Cook.Agent.track(%{module: __MODULE__, test: :"test x", file: __ENV__.file, line: 1}) ==
             :ok

    assert Tracker.finish_run(fn _key -> true end) == %{}
  end

  test "trace_prefix/2 matches phoenix_test_playwright's trace file names" do
    assert Cook.Agent.trace_prefix("SampleAppWeb.Features.LoginTest", "test a user signs in") ==
             "SampleAppWeb.Features.LoginTest.test_a_user_signs_in"
  end
end
