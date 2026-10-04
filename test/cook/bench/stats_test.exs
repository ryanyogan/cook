defmodule Cook.Bench.StatsTest do
  use ExUnit.Case, async: true

  alias Cook.Bench.Stats

  doctest Stats

  describe "percentile/2" do
    test "nearest rank over 20 samples" do
      samples = Enum.shuffle(Enum.map(1..20, &(&1 * 100)))

      assert Stats.percentile(samples, 50) == 1000
      assert Stats.percentile(samples, 95) == 1900
      assert Stats.percentile(samples, 100) == 2000
    end

    test "a single sample is every percentile" do
      assert Stats.percentile([7], 50) == 7
      assert Stats.percentile([7], 95) == 7
    end

    test "no samples" do
      assert Stats.percentile([], 50) == nil
    end
  end

  describe "summarize/1" do
    test "leaves out and counts missing values" do
      assert Stats.summarize([5, nil, 1, 3]) ==
               %{count: 3, missing: 1, min: 1, p50: 3, p95: 5, max: 5}
    end

    test "all missing" do
      assert Stats.summarize([nil]) ==
               %{count: 0, missing: 1, min: nil, p50: nil, p95: nil, max: nil}
    end
  end

  describe "speedup/2" do
    test "ratio rounded to two decimals" do
      assert Stats.speedup(47_280, 5_400) == 8.76
      assert Stats.speedup(60_000, 6_000) == 10.0
    end

    test "nil when a side is missing or zero" do
      assert Stats.speedup(nil, 100) == nil
      assert Stats.speedup(100, nil) == nil
      assert Stats.speedup(100, 0) == nil
    end
  end

  test "verdict_counts/1 treats unknown statuses as errors" do
    assert Stats.verdict_counts(["pass", "fail", "pass", "error", nil]) ==
             %{pass: 2, fail: 1, error: 2}
  end

  describe "report/2" do
    test "timings come from completed runs only" do
      rows = [
        %{wall_ms: 5000, status: "pass", duration_ms: 4970, first_test_ms: 30},
        %{wall_ms: 6000, status: "fail", duration_ms: 5960, first_test_ms: 50},
        %{wall_ms: 40, status: "error", duration_ms: 10, first_test_ms: nil}
      ]

      report = Stats.report(rows, 50_000)

      assert report.runs == 3
      assert report.verdicts == %{pass: 1, fail: 1, error: 1}
      assert report.wall_ms.count == 2
      assert report.wall_ms.p50 == 5000
      assert report.wall_ms.p95 == 6000
      assert report.first_test_ms.p50 == 30
      # CLI overhead (wall - duration) plus first_test_ms: 60 and 90.
      assert report.start_to_first_test_ms.p50 == 60
      assert report.start_to_first_test_ms.p95 == 90
      assert report.speedup_p50 == 10.0
      assert report.speedup_p95 == 8.33
    end

    test "no completed runs gives no speedup" do
      report = Stats.report([%{wall_ms: 40, status: "error", duration_ms: nil}], 50_000)

      assert report.wall_ms.p50 == nil
      assert report.speedup_p50 == nil
    end
  end
end
