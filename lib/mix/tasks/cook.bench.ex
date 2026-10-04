defmodule Mix.Tasks.Cook.Bench do
  @shortdoc "Times warm full-suite runs through bin/cook against the cold baseline"

  @moduledoc """
  Runs the sample suite warm through `bin/cook run --json` and compares the
  wall time with the cold baseline in `bench/baseline.json`.

      bin/cook start --detach
      mix cook.bench
      bin/cook stop

  The daemon must already be running; this task does not start it and does not
  boot the Cook application. Wall time is measured around the whole CLI
  process, so it includes bash, curl and the HTTP round trip.

  Options:

    * `--runs N` - number of runs (default 20)
    * `--baseline PATH` - baseline file (default `bench/baseline.json`)
    * `--out PATH` - where to write the result (default `bench/warm.json`)

  Run it on an otherwise idle machine, and not while `bin/baseline` is running.
  """

  use Mix.Task

  alias Cook.Bench.Stats

  @switches [runs: :integer, baseline: :string, out: :string]

  @impl Mix.Task
  def run(argv) do
    {opts, _rest} = OptionParser.parse!(argv, strict: @switches)
    runs = Keyword.get(opts, :runs, 20)
    baseline_path = Keyword.get(opts, :baseline, "bench/baseline.json")
    out = Keyword.get(opts, :out, "bench/warm.json")
    cli = Path.expand("bin/cook")

    baseline = read_baseline!(baseline_path)
    ensure_daemon!(cli)

    rows =
      for n <- 1..runs do
        row = run_once(cli, n)
        Mix.shell().info(format_row(row, runs))
        row
      end

    report = Stats.report(rows, baseline["total_ms"])

    result = %{
      schema: "cook.bench/1",
      recorded_at: DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601(),
      command: "bin/cook run --json",
      percentile_method: "nearest rank, over runs with a pass or fail verdict",
      baseline: %{
        file: baseline_path,
        total_ms: baseline["total_ms"],
        recorded_at: baseline["recorded_at"]
      },
      machine: %{
        cores: System.schedulers_online(),
        elixir: System.version(),
        otp: System.otp_release()
      },
      summary: report,
      runs: rows
    }

    File.mkdir_p!(Path.dirname(out))
    File.write!(out, Jason.encode_to_iodata!(result, pretty: true) ++ ["\n"])
    Mix.shell().info(format_report(report, out))
  end

  defp read_baseline!(path) do
    with {:ok, body} <- File.read(path),
         {:ok, %{"total_ms" => total} = baseline} when is_number(total) <- Jason.decode(body) do
      baseline
    else
      _other -> Mix.raise("no usable baseline at #{path}; run bin/baseline first")
    end
  end

  defp ensure_daemon!(cli) do
    case System.cmd(cli, ["status", "--json"], stderr_to_stdout: true) do
      {_out, 0} -> :ok
      {_out, _code} -> Mix.raise("the Cook daemon is not ready; run bin/cook start --detach")
    end
  end

  defp run_once(cli, n) do
    started = System.monotonic_time(:microsecond)
    {out, exit_code} = System.cmd(cli, ["run", "--json"])
    wall_ms = div(System.monotonic_time(:microsecond) - started + 500, 1000)

    verdict =
      case Jason.decode(out) do
        {:ok, %{} = verdict} -> verdict
        _other -> %{}
      end

    %{
      run: n,
      wall_ms: wall_ms,
      exit_code: exit_code,
      status: verdict["status"] || "error",
      duration_ms: verdict["duration_ms"],
      first_test_ms: get_in(verdict, ["timing", "first_test_ms"]),
      overhead_ms: get_in(verdict, ["timing", "overhead_ms"]),
      selected: verdict["selected"],
      failures: verdict |> Map.get("failures", []) |> Enum.map(& &1["test"]),
      error: get_in(verdict, ["error", "reason"])
    }
  end

  defp format_row(row, runs) do
    "run #{row.run}/#{runs}: #{row.status} wall #{row.wall_ms} ms, " <>
      "duration #{inspect(row.duration_ms)} ms, first test #{inspect(row.first_test_ms)} ms"
  end

  defp format_report(report, out) do
    """

    #{report.runs} runs: #{report.verdicts.pass} pass, #{report.verdicts.fail} fail, #{report.verdicts.error} error
    wall_ms                 p50 #{report.wall_ms.p50}  p95 #{report.wall_ms.p95}
    duration_ms             p50 #{report.duration_ms.p50}  p95 #{report.duration_ms.p95}
    first_test_ms           p50 #{report.first_test_ms.p50}  p95 #{report.first_test_ms.p95}
    start_to_first_test_ms  p50 #{report.start_to_first_test_ms.p50}  p95 #{report.start_to_first_test_ms.p95}
    baseline total #{report.baseline_total_ms} ms: #{inspect(report.speedup_p50)}x at p50, #{inspect(report.speedup_p95)}x at p95
    written to #{out}
    """
  end
end
