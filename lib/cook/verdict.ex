defmodule Cook.Verdict do
  @moduledoc """
  Turns the raw result of a run into the verdict agents build their loops on.

  The schema is versioned (`schema/0`): keys are never renamed or removed within
  a version, only added. Version 1:

      schema, run_id, status ("pass" | "fail" | "error"), path, duration_ms,
      timing: overhead_ms, tests_ms, slowest_test_ms, first_test_ms, queue_ms,
              ready_wait_ms, compile_ms, load_ms
      selected, skipped, selection_reason ("all" | "explicit"),
      counts: passed, failed, known
      failures: [test, name, module, kind, step, message, dom_snapshot,
                 console_errors, server_logs, trace, repro, duration_ms]
      quarantined: []
      error: nil | %{reason, message}
      seed

  Rules applied here, whatever ExUnit reported:

    * a test whose duration is over the per-test cap is a failure that tells the
      author to split it (a `@tag timeout:` in the test cannot lift the cap);
    * every failing test appears exactly once; nothing is retried.
  """

  @schema "cook.verdict/1"

  @top_keys ~w(schema run_id status path duration_ms timing selected skipped selection_reason
               counts failures quarantined error seed)a
  @timing_keys ~w(overhead_ms tests_ms slowest_test_ms first_test_ms queue_ms ready_wait_ms
                  compile_ms load_ms)a
  @failure_keys ~w(test name module kind step message dom_snapshot console_errors server_logs
                   trace repro duration_ms)a

  @doc """
  The schema version string, the only place it is defined.
  """
  def schema, do: @schema

  @doc """
  Builds a verdict from `Cook.Pool.run/2`'s return value.

  `context`: `:run_id`, `:path`, `:tests` (the requested test references, `[]`
  for all), `:cap_ms`, `:duration_ms` (request received to now), `:queue_ms`
  (waiting for other runs), `:wait_ms` (everything before the pool was asked to
  run: queue plus waiting for a ready pool).
  """
  def build({:ok, raw}, context) do
    cap_ms = context.cap_ms
    rows = test_rows(raw, cap_ms)
    failures = failures(raw, context)
    ran = Enum.filter(rows, &(&1.status in ["passed", "failed"]))
    tests_ms = raw.timing[:run_ms] || 0
    known = raw[:known_test_count] || length(rows) + (raw.counts[:excluded] || 0)

    %{
      schema: @schema,
      run_id: context.run_id,
      status: if(failures == [], do: "pass", else: "fail"),
      path: context.path,
      duration_ms: context.duration_ms,
      timing: %{
        overhead_ms: max(context.duration_ms - tests_ms, 0),
        tests_ms: tests_ms,
        slowest_test_ms: rows |> Enum.map(& &1.duration_ms) |> Enum.max(fn -> 0 end),
        first_test_ms: raw.timing[:first_test_ms] && context.wait_ms + raw.timing.first_test_ms,
        queue_ms: context.queue_ms,
        ready_wait_ms: context.wait_ms - context.queue_ms + (raw.timing[:ready_wait_ms] || 0),
        compile_ms: raw.timing[:compile_ms] || 0,
        load_ms: raw.timing[:load_ms] || 0
      },
      selected: length(ran),
      skipped: max(known - length(ran), 0),
      selection_reason: selection_reason(context.tests),
      counts: %{
        passed: Enum.count(ran, &(&1.status == "passed")),
        failed: Enum.count(ran, &(&1.status == "failed")),
        known: known
      },
      failures: failures,
      quarantined: [],
      error: nil,
      seed: raw[:seed],
      scheduling: raw[:scheduling]
    }
  end

  def build({:error, reason}, context) do
    {name, message} = describe_error(reason)

    %{
      schema: @schema,
      run_id: context.run_id,
      status: "error",
      path: context.path,
      duration_ms: context.duration_ms,
      timing: %{
        overhead_ms: context.duration_ms,
        tests_ms: 0,
        slowest_test_ms: 0,
        first_test_ms: nil,
        queue_ms: context.queue_ms,
        ready_wait_ms: context.wait_ms - context.queue_ms,
        compile_ms: 0,
        load_ms: 0
      },
      selected: 0,
      skipped: 0,
      selection_reason: selection_reason(context.tests),
      counts: %{passed: 0, failed: 0, known: 0},
      failures: [],
      quarantined: [],
      error: %{reason: name, message: message},
      seed: nil
    }
  end

  @doc """
  One row per test with the verdict's view of its status
  (`"passed" | "failed" | "skipped"`) and its start offset, for persistence.
  """
  def test_rows(raw, cap_ms) do
    first_us =
      raw.tests
      |> Enum.map(&Map.get(&1, :started_at_us))
      |> Enum.reject(&is_nil/1)
      |> Enum.min(fn -> nil end)

    for test <- raw.tests do
      started_us = Map.get(test, :started_at_us)

      %{
        started_ms: started_us && div(started_us - first_us, 1000),
        test_id: test.id,
        file: test.file,
        line: test.line,
        module: test.module,
        name: test.name,
        status: test |> effective_status(cap_ms) |> Atom.to_string(),
        duration_ms: test.duration_ms
      }
    end
  end

  @doc """
  The status of a test after the cap rule: `:passed | :failed | :skipped`.
  """
  def effective_status(%{status: :skipped}, _cap_ms), do: :skipped
  def effective_status(%{status: :passed, duration_ms: ms}, cap_ms) when ms <= cap_ms, do: :passed
  def effective_status(_test, _cap_ms), do: :failed

  @doc """
  The message of a test that ran into the per-test cap.
  """
  def cap_message(duration_ms, cap_ms) do
    "test took #{duration_ms} ms, over the per-test cap of #{cap_ms} ms. Split this test " <>
      "into smaller tests: the slowest test is the floor for every run."
  end

  @doc """
  Process exit code for a verdict: 0 pass, 1 fail, 2 error.
  """
  def exit_code(%{status: "pass"}), do: 0
  def exit_code(%{status: "fail"}), do: 1
  def exit_code(_verdict), do: 2

  @doc """
  The verdict as JSON, keys in a stable, readable order.
  """
  def to_json(verdict) do
    verdict
    |> ordered(@top_keys)
    |> Map.update!(:values, fn values ->
      values
      |> Keyword.update!(:timing, &ordered(&1, @timing_keys))
      |> Keyword.update!(:failures, fn failures ->
        Enum.map(failures, &ordered(&1, @failure_keys))
      end)
    end)
    |> Jason.encode_to_iodata!()
  end

  @doc """
  A short human summary of a verdict.
  """
  def summary(%{status: "error"} = verdict) do
    """
    ERROR  #{verdict.error.reason} after #{seconds(verdict.duration_ms)}
      #{indent(verdict.error.message, "  ")}
      run #{verdict.run_id}
    """
  end

  def summary(verdict) do
    timing = verdict.timing
    failed = verdict.counts.failed

    headline =
      case verdict.status do
        "pass" -> "PASS   #{verdict.selected} tests"
        "fail" -> "FAIL   #{failed} of #{verdict.selected} tests failed"
      end

    lines = [
      "#{headline} in #{seconds(verdict.duration_ms)} " <>
        "(tests #{timing.tests_ms} ms, overhead #{timing.overhead_ms} ms, " <>
        "first test after #{timing.first_test_ms || "-"} ms, slowest #{timing.slowest_test_ms} ms)",
      "  selected #{verdict.selected}, skipped #{verdict.skipped} (#{verdict.selection_reason}), " <>
        "run #{verdict.run_id}"
    ]

    failures =
      for {failure, index} <- Enum.with_index(verdict.failures, 1) do
        [
          "",
          "  #{index}) #{failure.test}  #{failure.name}",
          failure.step && "     step:    #{failure.step}",
          "     message: #{indent(failure.message, "              ")}",
          failure.console_errors != [] &&
            "     console: #{length(failure.console_errors)} error(s)",
          failure.server_logs != [] && "     logs:    #{length(failure.server_logs)} line(s)",
          failure.dom_snapshot && "     dom:     #{failure.dom_snapshot}",
          failure.trace && "     trace:   #{failure.trace}",
          "     repro:   #{failure.repro}"
        ]
      end

    [lines, failures] |> List.flatten() |> Enum.filter(& &1) |> Enum.join("\n") |> Kernel.<>("\n")
  end

  ## Failures

  defp failures(raw, context) do
    module_messages = Map.new(raw.module_failures, &{&1.module, &1.message})
    modules_with_tests = MapSet.new(raw.tests, & &1.module)

    test_failures =
      for test <- raw.tests, effective_status(test, context.cap_ms) == :failed do
        failure(test, module_messages, context)
      end

    orphan_module_failures =
      for failure <- raw.module_failures,
          not MapSet.member?(modules_with_tests, failure.module) do
        %{
          test: failure.file,
          name: failure.module,
          module: failure.module,
          kind: "setup_all",
          step: nil,
          message: failure.message,
          dom_snapshot: nil,
          console_errors: [],
          server_logs: [],
          trace: nil,
          repro: repro(context.path, failure.file),
          duration_ms: 0
        }
      end

    test_failures ++ orphan_module_failures
  end

  defp failure(test, module_messages, context) do
    detail = test.failure || %{}
    artifacts = Map.get(test, :artifacts) || %{}
    {kind, message} = kind_and_message(test, detail, module_messages, context.cap_ms)

    %{
      test: test.id,
      name: test.name,
      module: test.module,
      kind: kind,
      step: detail[:step],
      message: message,
      dom_snapshot: artifacts[:dom_snapshot],
      console_errors: artifacts[:console_errors] || [],
      server_logs: artifacts[:server_logs] || [],
      trace: artifacts[:trace],
      repro: repro(context.path, test.id),
      duration_ms: test.duration_ms
    }
  end

  defp kind_and_message(%{status: :invalid} = test, detail, module_messages, _cap_ms) do
    message = Map.get(module_messages, test.module) || detail[:message] || "setup_all failed"
    {"setup_all", "the module's setup_all failed, so this test did not run: " <> message}
  end

  defp kind_and_message(%{status: :passed} = test, _detail, _module_messages, cap_ms) do
    {"cap", cap_message(test.duration_ms, cap_ms)}
  end

  defp kind_and_message(%{duration_ms: ms}, %{timed_out: true}, _module_messages, cap_ms)
       when is_integer(ms) and is_integer(cap_ms) do
    {"cap", cap_message(if(ms > cap_ms, do: ms, else: cap_ms), cap_ms)}
  end

  defp kind_and_message(test, detail, _module_messages, cap_ms) do
    message = String.trim(detail[:message] || "test failed")

    if test.duration_ms > cap_ms do
      {"assertion", message <> "\n(also: " <> cap_message(test.duration_ms, cap_ms) <> ")"}
    else
      {"assertion", message}
    end
  end

  defp repro(path, test), do: "cook run #{path} #{test}"

  defp selection_reason([]), do: "all"
  defp selection_reason(_tests), do: "explicit"

  ## Errors

  defp describe_error(:pool_not_running),
    do: {"pool_not_running", "the warm pool is not running in this daemon"}

  defp describe_error({:unknown_app, path}),
    do: {"unknown_app", "#{inspect(path)} is not an app this daemon keeps warm"}

  defp describe_error({:not_ready, status}),
    do: {"pool_not_ready", "the pool did not become ready in time: #{inspect(status)}"}

  defp describe_error({:compile_failed, diagnostics}),
    do: {"compile_failed", "the app did not compile:\n" <> diagnostics(diagnostics)}

  defp describe_error({:test_load_failed, diagnostics}),
    do: {"test_load_failed", "test files did not compile:\n" <> diagnostics(diagnostics)}

  defp describe_error({:unknown_tests, refs}),
    do: {"unknown_tests", "no such test file or directory: " <> Enum.join(refs, ", ")}

  defp describe_error({:browser_server_down, reason}) do
    {"browser_server_down",
     "the browser server died during the run (#{inspect(reason)}); the run was abandoned, " <>
       "the pool restarts it and the next run waits for it"}
  end

  defp describe_error({:instance_down, reason}) do
    {"app_instance_down",
     "the app instance died during the run (#{inspect(reason)}); the run was abandoned, " <>
       "the pool restarts it and the next run waits for it"}
  end

  defp describe_error({:run_timeout, ms}),
    do: {"run_timeout", "the run did not finish within #{ms} ms"}

  defp describe_error({:agent_crashed, text}), do: {"agent_crashed", to_string(text)}
  defp describe_error({:runner_crashed, text}), do: {"runner_crashed", to_string(text)}
  defp describe_error(other), do: {"unexpected", inspect(other)}

  defp diagnostics(diagnostics) do
    Enum.map_join(diagnostics, "\n", fn diagnostic ->
      "#{diagnostic[:file]}:#{diagnostic[:line]}: #{diagnostic[:message]}"
    end)
  end

  ## Helpers

  defp ordered(map, keys) do
    known = for key <- keys, Map.has_key?(map, key), do: {key, Map.fetch!(map, key)}
    extra = map |> Map.drop(keys) |> Enum.sort()
    Jason.OrderedObject.new(known ++ extra)
  end

  defp seconds(ms), do: "#{:erlang.float_to_binary(ms / 1000, decimals: 2)} s"

  defp indent(text, prefix) do
    text |> to_string() |> String.trim_trailing() |> String.replace("\n", "\n" <> prefix)
  end
end
