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
end
