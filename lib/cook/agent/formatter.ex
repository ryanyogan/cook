defmodule Cook.Agent.Formatter do
  @moduledoc """
  ExUnit formatter that collects per-test results for a Cook run.

  It runs inside the target app's VM (injected by `Cook.Pool.AppInstance`), so it
  may only use Elixir, OTP and ExUnit. Results are plain maps and strings, never
  structs or exceptions of the target app, so they can cross to the Cook node.

  When the suite finishes, the collected report is sent to the pid given in the
  `:cook_report_to` ExUnit option as `{:cook_report, ref, report}`.
  """

  use GenServer

  @compile {:no_warn_undefined, [ExUnit.Formatter]}

  @impl true
  def init(opts) do
    {:ok,
     %{
       report_to: opts[:cook_report_to],
       ref: opts[:cook_run_ref],
       started: %{},
       first_test_at_us: nil,
       tests: [],
       module_failures: []
     }}
  end

  @impl true
  def handle_cast({:test_started, test}, state) do
    now = System.system_time(:microsecond)

    {:noreply,
     %{
       state
       | started: Map.put(state.started, {test.module, test.name}, now),
         first_test_at_us: state.first_test_at_us || now
     }}
  end

  def handle_cast({:test_finished, test}, state) do
    {started_at, started} = Map.pop(state.started, {test.module, test.name})
    {:noreply, %{state | started: started, tests: [result(test, started_at) | state.tests]}}
  end

  def handle_cast({:module_finished, %{state: {:failed, failures}} = test_module}, state) do
    failure = %{
      module: inspect(test_module.name),
      file: relative(test_module.file),
      message: failures |> Enum.map(&message/1) |> Enum.join("\n")
    }

    {:noreply, %{state | module_failures: [failure | state.module_failures]}}
  end

  def handle_cast({:suite_finished, times_us}, state) do
    if state.report_to do
      send(state.report_to, {:cook_report, state.ref, report(state, times_us)})
    end

    {:noreply, state}
  end

  def handle_cast(_event, state), do: {:noreply, state}

  @doc """
  Builds the report sent at the end of a suite. Excluded tests are counted, not listed.
  """
  def report(state, times_us) do
    {excluded, tests} = Enum.split_with(state.tests, &(&1.status == :excluded))

    %{
      tests: Enum.reverse(tests),
      excluded: length(excluded),
      module_failures: Enum.reverse(state.module_failures),
      first_test_at_us: state.first_test_at_us,
      run_us: times_us[:run]
    }
  end

  @doc """
  Turns a finished `%ExUnit.Test{}` into a plain result map.
  """
  def result(test, started_at_us \\ nil) do
    file = relative(test.tags[:file])
    line = test.tags[:line]
    duration_us = test.time || 0

    %{
      id: "#{file}:#{line}",
      file: file,
      line: line,
      module: inspect(test.module),
      name: Atom.to_string(test.name),
      status: status(test.state),
      duration_us: duration_us,
      duration_ms: div(duration_us + 500, 1000),
      started_at_us: started_at_us,
      failure: failure(test, file),
      logs: test.logs || ""
    }
  end

  @doc """
  Maps an ExUnit test state to `:passed | :failed | :skipped | :excluded | :invalid`.
  """
  def status(nil), do: :passed
  def status({:failed, _failures}), do: :failed
  def status({:skipped, _reason}), do: :skipped
  def status({:excluded, _reason}), do: :excluded
  def status({:invalid, _module}), do: :invalid

  defp failure(%{state: {:failed, failures}} = test, file) do
    frames = failures |> Enum.flat_map(fn {_kind, _reason, stack} -> stack end) |> frames()
    step_line = step_line(frames, file)

    %{
      message: failures |> Enum.map(&message/1) |> Enum.join("\n"),
      timed_out: Enum.any?(failures, &timed_out?/1),
      formatted: formatted(test, failures),
      stacktrace: frames,
      step_line: step_line,
      step: step_source(file, step_line)
    }
  end

  defp failure(%{state: {:invalid, _module}}, _file) do
    %{
      message: "the test module's setup_all failed, so this test did not run",
      timed_out: false,
      formatted: nil,
      stacktrace: [],
      step_line: nil,
      step: nil
    }
  end

  defp failure(_test, _file), do: nil

  defp message({:error, %{__exception__: true} = exception, _stack}) do
    Exception.message(exception)
  rescue
    _error -> inspect(exception)
  end

  defp message({kind, reason, _stack}), do: Exception.format_banner(kind, reason)

  defp timed_out?({:error, %{__struct__: ExUnit.TimeoutError}, _stack}), do: true
  defp timed_out?(_failure), do: false

  defp formatted(test, failures) do
    test
    |> ExUnit.Formatter.format_test_failure(failures, 1, 100, fn _key, text -> text end)
    |> IO.iodata_to_binary()
  rescue
    _error -> nil
  end

  defp frames(stacktrace) do
    for {module, function, arity, location} <- stacktrace do
      arity = if is_list(arity), do: length(arity), else: arity

      %{
        module: inspect(module),
        function: "#{function}/#{arity}",
        file: location[:file] && relative(to_string(location[:file])),
        line: location[:line]
      }
    end
  end

  # The failing step is the innermost frame that is in the test file itself.
  defp step_line(frames, file) do
    Enum.find_value(frames, fn frame -> frame.file == file && frame.line end)
  end

  defp step_source(_file, nil), do: nil

  defp step_source(file, line) do
    case File.read(file) do
      {:ok, source} ->
        case source |> String.split("\n") |> Enum.at(line - 1) do
          nil -> nil
          text -> String.trim(text)
        end

      {:error, _reason} ->
        nil
    end
  end

  defp relative(nil), do: nil
  defp relative(path), do: Path.relative_to_cwd(path)
end
