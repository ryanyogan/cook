defmodule Cook.Runs.Ordering do
  @moduledoc """
  Longest-first scheduling.

  ExUnit starts test modules in the order it is given and runs the tests of one
  module serially, so the unit that can be ordered is the module: modules are
  sorted by the sum of their tests' last recorded durations, longest first.
  """

  @doc """
  `durations` is a list of `%{module: String, duration_ms: integer}`, one entry
  per test (its most recent duration). Returns module names, longest total
  first; ties are broken by name so the order is stable.
  """
  def module_order(durations) do
    durations
    |> Enum.group_by(& &1.module, & &1.duration_ms)
    |> Enum.map(fn {module, times} -> {module, Enum.sum(times)} end)
    |> Enum.sort_by(fn {module, total} -> {-total, module} end)
    |> Enum.map(fn {module, _total} -> module end)
  end
end
