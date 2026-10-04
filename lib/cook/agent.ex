defmodule Cook.Agent do
  @moduledoc """
  The part of Cook that runs inside a target app's VM.

  `Cook.Pool.AppInstance` injects this module (and `Cook.Agent.Formatter`) into the
  instance node; the target app does not depend on Cook. Code here may only use
  Elixir, OTP, ExUnit and Mix, and must return plain data.

  `boot/1` runs once per instance: it starts ExUnit without the at-exit run,
  requires the app's test helper (which opens the one warm browser connection)
  and loads every test file. `run/1` then runs tests as often as asked without
  booting anything: recompile in the VM, reload changed test files, run.
  """

  @compile {:no_warn_undefined,
            [ExUnit, ExUnit.Filters, Mix, Mix.Project, Mix.Task, Mix.Task.Compiler]}

  alias Cook.Agent.Tracker

  @state_key {__MODULE__, :state}
  @lock_resource {__MODULE__, :run}
  @default_timeout_ms 10_000
  @report_timeout_ms 5_000

  @doc """
  Prepares the instance. Options: `:test_paths` (default `["test"]`) and
  `:test_helper` (default `"test/test_helper.exs"`), relative to the app root.

  Returns `{:ok, info}` or `{:error, description}`. The test helper runs in a
  process that stays alive for the life of the VM, because the supervisors it
  starts are linked to it; its pid is `info.holder`.
  """
  def boot(opts \\ []) do
    caller = self()
    ref = make_ref()

    holder =
      spawn(fn ->
        local_output()
        result = guarded(fn -> do_boot(opts) end)
        send(caller, {ref, result})
        if match?({:ok, _info}, result), do: Process.sleep(:infinity)
      end)

    monitor = Process.monitor(holder)

    receive do
      {^ref, {:ok, info}} ->
        Process.demonitor(monitor, [:flush])
        {:ok, Map.put(info, :holder, holder)}

      {^ref, {:error, _reason} = error} ->
        Process.demonitor(monitor, [:flush])
        error

      {:DOWN, ^monitor, :process, _pid, reason} ->
        {:error, {:boot_crashed, inspect(reason)}}
    end
  end

  @doc """
  Runs tests on the booted instance. One run at a time; concurrent callers wait.

  Options:
    * `:tests` - list of `"file"`, `"file:line"` or `"dir"`; empty means everything loaded
    * `:module_order` - module names (strings) in the order they should start
    * `:timeout_ms` - per-test cap (default #{@default_timeout_ms})
    * `:max_cases` - concurrent test modules
    * `:seed` - ExUnit seed, default `0` (tests in a module run in file order)
    * `:reload_tests` - reload every test file, not only changed ones
    * `:artifacts_dir` - where failure artifacts of this run go (default: none collected)
    * `:trace` - record a Playwright trace per test and keep those of failed tests

  Returns `{:ok, report}` or `{:error, reason}`.
  """
  def run(opts \\ []) do
    entered_us = System.system_time(:microsecond)
    local_output()
    lock = {@lock_resource, self()}
    :global.set_lock(lock, [node()])

    try do
      guarded(fn -> do_run(opts, entered_us) end)
    after
      :global.del_lock(lock, [node()])
    end
  end

  @doc """
  The opt-in hook for a target app's browser case template; see `Cook.Agent.Tracker`.
  Does nothing outside a Cook run and never raises.
  """
  def track(context), do: Tracker.track(context)

  @doc """
  The prefix `phoenix_test_playwright` gives the trace file of a test
  (`PhoenixTest.Playwright.Case` names it `<prefix>_<time>_<unique>.zip`).
  """
  def trace_prefix(module, name) when is_binary(module) and is_binary(name) do
    String.replace("#{module}.#{name}", ~r/[^a-zA-Z0-9\.]/, "_")
  end

  @doc """
  Orders `modules` so that those named in `order` (strings) come first, in that
  order, followed by the rest in their existing order.
  """
  def order_modules(modules, order) do
    rank = order |> Enum.with_index() |> Map.new()
    count = map_size(rank)

    modules
    |> Enum.with_index()
    |> Enum.sort_by(fn {module, index} -> Map.get(rank, inspect(module), count + index) end)
    |> Enum.map(fn {module, _index} -> module end)
  end

  @doc """
  Splits a `"file"` or `"file:line"` test reference into `{file, line | nil}`.
  """
  def parse_test(ref) do
    with [file, line] <- String.split(ref, ":", parts: 2),
         {line, ""} <- Integer.parse(line) do
      {file, line}
    else
      _other -> {ref, nil}
    end
  end

  @doc """
  Works out which known files a list of test references selects.

  `known` is the list of loaded test files. Returns `{:ok, files, line_refs}`
  where `line_refs` are the `"file:line"` references (empty when whole files
  were asked for), or `{:error, {:unknown_tests, refs}}`.
  """
  def select([], known), do: {:ok, known, []}

  def select(refs, known) do
    parsed =
      for ref <- refs do
        {path, line} = parse_test(ref)
        path = Path.relative_to_cwd(path)
        files = Enum.filter(known, &(&1 == path or String.starts_with?(&1, path <> "/")))
        {ref, path, line, files}
      end

    case for {ref, _path, _line, []} <- parsed, do: ref do
      [] ->
        files = parsed |> Enum.flat_map(&elem(&1, 3)) |> Enum.uniq()

        if Enum.any?(parsed, fn {_ref, _path, line, _files} -> line end) do
          line_refs =
            Enum.flat_map(parsed, fn
              {_ref, path, nil, files} -> if files == [path], do: [path], else: files
              {_ref, path, line, _files} -> ["#{path}:#{line}"]
            end)

          {:ok, files, line_refs}
        else
          {:ok, files, []}
        end

      unknown ->
        {:error, {:unknown_tests, unknown}}
    end
  end

  @doc """
  Lists the test files under `test_paths` (directories or files), sorted.
  """
  def discover(test_paths) do
    test_paths
    |> Enum.flat_map(fn path ->
      if File.dir?(path), do: Path.wildcard(Path.join(path, "**/*_test.exs")), else: [path]
    end)
    |> Enum.filter(&File.regular?/1)
    |> Enum.uniq()
    |> Enum.sort()
  end

  ## Boot

  defp do_boot(opts) do
    test_paths = Keyword.get(opts, :test_paths, ["test"])
    helper = Keyword.get(opts, :test_helper, "test/test_helper.exs")

    if function_exported?(Mix, :ensure_application!, 1), do: Mix.ensure_application!(:ex_unit)
    _ = Application.load(:ex_unit)
    Application.put_env(:ex_unit, :autorun, false)
    Code.compiler_options(ignore_module_conflict: true)

    if File.regular?(helper), do: Code.require_file(helper)
    Tracker.install()

    base_filters = Keyword.take(ExUnit.configuration(), [:include, :exclude])

    state = %{
      test_paths: test_paths,
      files: %{},
      support: support_signature(),
      base_filters: base_filters
    }

    started = System.monotonic_time()

    case reload(state, true) do
      {:ok, state, loaded} ->
        :persistent_term.put(@state_key, state)

        {:ok,
         %{
           load_ms: elapsed_ms(started),
           files: length(loaded),
           modules: state.files |> Map.values() |> Enum.map(&length(&1.modules)) |> Enum.sum()
         }}

      {:error, diagnostics} ->
        {:error, {:test_load_failed, diagnostics}}
    end
  end

  ## Run

  defp do_run(opts, entered_us) do
    case :persistent_term.get(@state_key, nil) do
      nil -> {:error, :not_booted}
      state -> do_run(opts, entered_us, state)
    end
  end

  defp do_run(opts, entered_us, state) do
    lock_wait_us = System.system_time(:microsecond) - entered_us
    started = System.monotonic_time()

    with {:ok, compile} <- recompile(),
         compile_ms = elapsed_ms(started),
         load_started = System.monotonic_time(),
         support = support_signature(),
         force? = Keyword.get(opts, :reload_tests, false) or support != state.support,
         {:ok, state, reloaded} <- reload(%{state | support: support}, force?),
         :persistent_term.put(@state_key, state),
         load_ms = elapsed_ms(load_started),
         known = state.files |> Map.keys() |> Enum.sort(),
         {:ok, files, line_refs} <- select(Keyword.get(opts, :tests, []), known) do
      modules =
        files
        |> Enum.flat_map(&state.files[&1].modules)
        |> order_modules(Keyword.get(opts, :module_order, []))

      seed = Keyword.get(opts, :seed, 0)
      report = modules |> execute_with_artifacts(line_refs, seed, opts, state)

      first_test_ms =
        report.first_test_at_us && div(report.first_test_at_us - entered_us + 500, 1000)

      {:ok,
       %{
         tests: report.tests,
         module_failures: report.module_failures,
         counts: counts(report),
         seed: seed,
         compile: compile,
         reloaded_files: reloaded,
         known_tests: length(known),
         known_test_count: known_test_count(state),
         timing: %{
           entered_at_us: entered_us,
           first_test_at_us: report.first_test_at_us,
           lock_wait_ms: div(lock_wait_us, 1000),
           compile_ms: compile_ms,
           load_ms: load_ms,
           first_test_ms: first_test_ms,
           run_ms: report.run_us && div(report.run_us + 500, 1000),
           agent_ms: div(System.system_time(:microsecond) - entered_us + 500, 1000)
         }
       }}
    else
      {:error, :compile_failed, diagnostics} -> {:error, {:compile_failed, diagnostics}}
      {:error, {:unknown_tests, _refs} = reason} -> {:error, reason}
      {:error, diagnostics} -> {:error, {:test_load_failed, diagnostics}}
    end
  end

  defp known_test_count(state) do
    for {_file, %{modules: modules}} <- state.files, module <- modules, reduce: 0 do
      count -> count + length(module.__ex_unit__().tests)
    end
  end

  # Collects failure artifacts around the run when an artifacts dir is given.
  defp execute_with_artifacts(modules, line_refs, seed, opts, state) do
    case Keyword.get(opts, :artifacts_dir) do
      nil ->
        set_trace(nil)
        execute(modules, line_refs, seed, opts, state)

      dir ->
        timeout = Keyword.get(opts, :timeout_ms, @default_timeout_ms)
        trace_dir = if Keyword.get(opts, :trace, false), do: Path.join(dir, "traces")
        Tracker.start_run(dir)
        set_trace(trace_dir)

        report =
          try do
            execute(modules, line_refs, seed, opts, state)
          after
            set_trace(nil)
          end

        kept = for test <- report.tests, keep_artifacts?(test, timeout), do: test
        keys = MapSet.new(kept, &{&1.module, &1.name})
        artifacts = Tracker.finish_run(&MapSet.member?(keys, &1))
        traces = traces(trace_dir, dir, kept)

        tests =
          for test <- report.tests do
            key = {test.module, test.name}

            if MapSet.member?(keys, key) do
              found = Map.get(artifacts, key, %{})

              Map.put(test, :artifacts, %{
                dom_snapshot: Map.get(found, :dom_snapshot),
                console_errors: Map.get(found, :console_errors, []),
                server_logs: Map.get(found, :server_logs, []),
                trace: Map.get(traces, key),
                tracked: Map.has_key?(artifacts, key)
              })
            else
              test
            end
          end

        _ = File.rmdir(dir)
        %{report | tests: tests}
    end
  end

  defp keep_artifacts?(test, timeout) do
    test.status in [:failed, :invalid] or test.duration_ms > timeout
  end

  # `phoenix_test_playwright` reads its config at every test setup, so tracing
  # can be switched per run.
  defp set_trace(trace_dir) do
    case Application.get_env(:phoenix_test, :playwright) do
      config when is_list(config) ->
        config =
          if trace_dir,
            do: Keyword.merge(config, trace: true, trace_dir: trace_dir),
            else: Keyword.drop(config, [:trace, :trace_dir])

        Application.put_env(:phoenix_test, :playwright, config)

      _other ->
        :ok
    end
  end

  # Moves the traces of the kept tests next to the other artifacts and deletes the rest.
  defp traces(nil, _dir, _kept), do: %{}

  defp traces(trace_dir, dir, kept) do
    files = trace_dir |> Path.join("*.zip") |> Path.wildcard()

    found =
      for test <- kept, reduce: %{} do
        acc ->
          pattern =
            Regex.compile!(
              "^" <> Regex.escape(trace_prefix(test.module, test.name)) <> "_\\d+_\\d+\\.zip$"
            )

          case Enum.find(files, &Regex.match?(pattern, Path.basename(&1))) do
            nil ->
              acc

            file ->
              target = Path.join(dir, Tracker.file_name(test) <> ".zip")
              File.rename!(file, target)
              Map.put(acc, {test.module, test.name}, target)
          end
      end

    _ = File.rm_rf(trace_dir)
    found
  end

  defp execute([], _line_refs, _seed, _opts, _state) do
    %{tests: [], excluded: 0, module_failures: [], first_test_at_us: nil, run_us: 0}
  end

  defp execute(modules, line_refs, seed, opts, state) do
    ref = make_ref()
    {include, exclude} = filters(line_refs, state.base_filters)

    ExUnit.configure(
      formatters: [Cook.Agent.Formatter],
      timeout: Keyword.get(opts, :timeout_ms, @default_timeout_ms),
      max_cases: Keyword.get(opts, :max_cases, System.schedulers_online()),
      seed: seed,
      include: include,
      exclude: exclude,
      only_test_ids: nil,
      max_failures: :infinity,
      repeat_until_failure: 0,
      cook_report_to: self(),
      cook_run_ref: ref
    )

    _stats = ExUnit.run(modules)

    receive do
      {:cook_report, ^ref, report} -> report
    after
      @report_timeout_ms -> raise "Cook.Agent.Formatter did not report results"
    end
  end

  defp filters([], base), do: {Keyword.get(base, :include, []), Keyword.get(base, :exclude, [])}

  defp filters(line_refs, _base) do
    {_paths, filters} = ExUnit.Filters.parse_paths(line_refs)
    {Keyword.get(filters, :include, []), Keyword.get(filters, :exclude, [])}
  end

  defp counts(report) do
    by_status = Enum.frequencies_by(report.tests, & &1.status)

    %{
      total: length(report.tests),
      passed: Map.get(by_status, :passed, 0),
      failed: Map.get(by_status, :failed, 0),
      invalid: Map.get(by_status, :invalid, 0),
      skipped: Map.get(by_status, :skipped, 0),
      excluded: report.excluded
    }
  end

  ## Compiling app code

  # Same steps as `IEx.Helpers.recompile/0`.
  defp recompile do
    config = Mix.Project.config()
    Mix.Task.Compiler.reenable(config[:compilers] || Mix.compilers())
    consolidation = Mix.Project.consolidation_path(config)
    args = ["--purge-consolidation-path-if-stale", consolidation, "--return-errors"]

    case Mix.Task.run("compile", args) do
      {:error, diagnostics} -> {:error, :compile_failed, Enum.map(diagnostics, &diagnostic/1)}
      {status, _diagnostics} -> {:ok, status}
      _other -> {:ok, :noop}
    end
  end

  ## Loading test files

  # Loads new or changed test files (all of them when `force?`) and forgets
  # deleted ones. Returns the files that were loaded.
  defp reload(state, force?) do
    files = discover(state.test_paths)
    signatures = Map.new(files, &{&1, signature(&1)})

    stale =
      Enum.filter(files, fn file ->
        force? or get_in(state.files, [file, :signature]) != signatures[file]
      end)

    removed = Map.keys(state.files) -- files
    Enum.each(removed, &unload(state.files[&1].modules))
    kept = Map.drop(state.files, removed)

    case load(stale) do
      {:ok, modules_by_file} ->
        loaded =
          Map.new(stale, fn file ->
            modules = Map.get(modules_by_file, file, [])
            unload(previous_modules(kept, file) -- modules)
            {file, %{signature: signatures[file], modules: modules}}
          end)

        {:ok, %{state | files: Map.merge(kept, loaded)}, stale}

      {:error, diagnostics} ->
        {:error, diagnostics}
    end
  end

  defp load([]), do: {:ok, %{}}

  defp load(files) do
    parent = self()
    ref = make_ref()

    result =
      Kernel.ParallelCompiler.compile(files,
        each_module: fn file, module, _binary -> send(parent, {ref, file, module}) end,
        return_diagnostics: true
      )

    modules = collect_modules(ref, [])

    # Loading registers the modules with ExUnit in load order. Drain that queue
    # so the next run starts modules in the order Cook asks for.
    drain_ex_unit()

    case result do
      {:ok, _modules, _warnings} ->
        {:ok,
         modules
         |> Enum.filter(fn {_file, module} -> function_exported?(module, :__ex_unit__, 1) end)
         |> Enum.group_by(fn {file, _module} -> Path.relative_to_cwd(file) end, &elem(&1, 1))}

      {:error, errors, _warnings} ->
        {:error, errors |> List.wrap() |> Enum.map(&diagnostic/1)}
    end
  end

  defp collect_modules(ref, acc) do
    receive do
      {^ref, file, module} -> collect_modules(ref, [{file, module} | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  defp drain_ex_unit do
    ExUnit.configure(formatters: [], only_test_ids: MapSet.new())
    _stats = ExUnit.run()
    ExUnit.configure(only_test_ids: nil)
  end

  defp previous_modules(files, file) do
    case files do
      %{^file => %{modules: modules}} -> modules
      _other -> []
    end
  end

  defp unload(modules) do
    for module <- modules do
      :code.purge(module)
      :code.delete(module)
    end
  end

  defp signature(file) do
    case File.stat(file, time: :posix) do
      {:ok, stat} -> {stat.mtime, stat.size}
      {:error, _reason} -> nil
    end
  end

  # Test support code is compiled by Mix, but test modules that use its macros
  # were expanded against the old version, so a change there reloads all tests.
  defp support_signature do
    "test/support/**/*.ex" |> Path.wildcard() |> Enum.sort() |> Enum.map(&{&1, signature(&1)})
  end

  ## Helpers

  defp diagnostic(%{message: message} = diagnostic) do
    file = Map.get(diagnostic, :file)

    %{
      file: file && Path.relative_to_cwd(file),
      line: position_line(Map.get(diagnostic, :position)),
      severity: Map.get(diagnostic, :severity, :error),
      message: IO.iodata_to_binary(message)
    }
  end

  defp diagnostic({file, position, message}) do
    %{
      file: Path.relative_to_cwd(file),
      line: position_line(position),
      severity: :error,
      message: IO.iodata_to_binary(message)
    }
  end

  defp diagnostic(other), do: %{file: nil, line: nil, severity: :error, message: inspect(other)}

  defp position_line({line, _column}), do: line
  defp position_line(line) when is_integer(line), do: line
  defp position_line(_position), do: nil

  # Calls arrive over distribution with the Cook node's group leader. Switch to
  # this VM's own, so compiler and test output stays in the instance's log.
  defp local_output do
    case Process.whereis(:user) do
      nil -> :ok
      user -> Process.group_leader(self(), user)
    end
  end

  defp elapsed_ms(started) do
    System.convert_time_unit(System.monotonic_time() - started, :native, :millisecond)
  end

  defp guarded(fun) do
    fun.()
  catch
    kind, reason -> {:error, {:agent_crashed, Exception.format(kind, reason, __STACKTRACE__)}}
  end
end
