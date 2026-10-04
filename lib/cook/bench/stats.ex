defmodule Cook.Bench.Stats do
  @moduledoc """
  Pure math for `mix cook.bench`: percentiles, summaries and the speedup
  against the cold baseline. No I/O here.
  """

  @doc """
  Nearest-rank percentile: the smallest sample such that at least `p` percent
  of the samples are less than or equal to it. Returns `nil` for no samples.

      iex> Cook.Bench.Stats.percentile([30, 10, 20, 40], 50)
      20
      iex> Cook.Bench.Stats.percentile(Enum.to_list(1..20), 95)
      19
  """
  def percentile([], _p), do: nil

  def percentile(samples, p) when is_list(samples) and p > 0 and p <= 100 do
    sorted = Enum.sort(samples)
    rank = ceil(p / 100 * length(sorted))
    Enum.at(sorted, max(rank, 1) - 1)
  end

  @doc """
  Summary of a list of samples. `nil` entries (a run that produced no value,
  for example an error verdict without a first test) are left out and counted.
  """
  def summarize(samples) when is_list(samples) do
    present = Enum.reject(samples, &is_nil/1)

    %{
      count: length(present),
      missing: length(samples) - length(present),
      min: if(present == [], do: nil, else: Enum.min(present)),
      p50: percentile(present, 50),
      p95: percentile(present, 95),
      max: if(present == [], do: nil, else: Enum.max(present))
    }
  end

  @doc """
  How many times faster `warm_ms` is than `baseline_ms`, rounded to two
  decimals. `nil` when either side is missing or not positive.
  """
  def speedup(baseline_ms, warm_ms)
      when is_number(baseline_ms) and is_number(warm_ms) and baseline_ms > 0 and warm_ms > 0 do
    Float.round(baseline_ms / warm_ms, 2)
  end

  def speedup(_baseline_ms, _warm_ms), do: nil

  @doc "Counts verdict statuses; anything other than pass/fail counts as error."
  def verdict_counts(statuses) when is_list(statuses) do
    Enum.reduce(statuses, %{pass: 0, fail: 0, error: 0}, fn
      "pass", acc -> Map.update!(acc, :pass, &(&1 + 1))
      "fail", acc -> Map.update!(acc, :fail, &(&1 + 1))
      _other, acc -> Map.update!(acc, :error, &(&1 + 1))
    end)
  end

  @doc """
  Builds the report from per-run rows and the baseline total.

  A row is `%{wall_ms:, status:, duration_ms:, first_test_ms:}`. Timing
  statistics use only runs that produced a pass or fail verdict; error runs
  did not run the suite, so their times would flatter the result.

  `start_to_first_test_ms` is CLI start to the first test executing: the CLI's
  wall time outside the daemon (`wall_ms - duration_ms`) plus `first_test_ms`.
  """
  def report(rows, baseline_total_ms) when is_list(rows) do
    completed = Enum.filter(rows, &(&1.status in ["pass", "fail"]))
    wall = summarize(Enum.map(completed, & &1.wall_ms))

    %{
      runs: length(rows),
      verdicts: verdict_counts(Enum.map(rows, & &1.status)),
      wall_ms: wall,
      duration_ms: summarize(Enum.map(completed, & &1.duration_ms)),
      first_test_ms: summarize(Enum.map(completed, & &1.first_test_ms)),
      start_to_first_test_ms: summarize(Enum.map(completed, &start_to_first_test/1)),
      baseline_total_ms: baseline_total_ms,
      speedup_p50: speedup(baseline_total_ms, wall.p50),
      speedup_p95: speedup(baseline_total_ms, wall.p95)
    }
  end

  defp start_to_first_test(%{wall_ms: wall, duration_ms: duration, first_test_ms: first})
       when is_number(wall) and is_number(duration) and is_number(first) do
    max(wall - duration, 0) + first
  end

  defp start_to_first_test(_row), do: nil
end
