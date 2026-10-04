defmodule Cook.Runs.Ordering do
  @moduledoc """
  Longest-first scheduling.

  The instance orders its scheduling units (single tests of split modules, whole
  modules otherwise; see `Cook.Agent.Shards`) by the last recorded durations of
  their tests, longest first. `test_durations/1` is what it gets for that;
  `module_order/1` is the tie-break and the order of modules that stay whole.
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

  @doc """
  The same entries (which also carry `:name` and `:status`) as
  `{module, test_name, ms}` tuples, the form that crosses to the instance.

  A failed test recorded with 0 ms is left out, so it counts as unknown: ExUnit
  reports no time for a test it killed at the cap, and that is the last test
  that should be planned as the shortest.
  """
  def test_durations(durations) do
    for %{module: module, name: name, duration_ms: ms} = entry <- durations,
        not (ms == 0 and Map.get(entry, :status) == "failed") do
      {module, name, ms}
    end
  end
end
