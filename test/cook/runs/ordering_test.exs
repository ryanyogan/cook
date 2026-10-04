defmodule Cook.Runs.OrderingTest do
  use ExUnit.Case, async: true

  alias Cook.Runs.Ordering

  test "modules are ordered by the sum of their tests' durations, longest first" do
    durations = [
      %{module: "A", duration_ms: 100},
      %{module: "B", duration_ms: 900},
      %{module: "A", duration_ms: 300},
      %{module: "C", duration_ms: 2_000},
      %{module: "D", duration_ms: 400}
    ]

    assert Ordering.module_order(durations) == ["C", "B", "A", "D"]
    assert Ordering.module_order([]) == []
  end

  test "test_durations/1 gives tuples and treats a failed 0 ms test (killed at the cap) as unknown" do
    durations = [
      %{module: "A", name: "test one", status: "passed", duration_ms: 100},
      %{module: "A", name: "test instant", status: "passed", duration_ms: 0},
      %{module: "A", name: "test capped", status: "failed", duration_ms: 0},
      %{module: "B", name: "test red", status: "failed", duration_ms: 40}
    ]

    assert Ordering.test_durations(durations) == [
             {"A", "test one", 100},
             {"A", "test instant", 0},
             {"B", "test red", 40}
           ]
  end
end
