defmodule Cook.Agent.Shards do
  @moduledoc """
  Scheduling below the module: lets tests of one `async: true` module run at the
  same time.

  ExUnit runs the tests of a module serially, so the floor of a run is its
  longest module. This module cuts a module into "shards": small proxy modules
  that each expose a subset of the real module's tests. ExUnit schedules every
  shard like any other async module, so the floor becomes the slowest test.

  ## ExUnit internals this relies on (checked against Elixir 1.20.4)

  This is the only place in Cook that depends on them. If one of them changes,
  `prepare/3` falls back to whole modules instead of failing the run.

    * `ExUnit.run(modules)` takes any module that exports `__ex_unit__/1` and
      registers it with `module.__ex_unit__(:config)`, a map with `:async?`,
      `:group` and `:parameterize` (`ExUnit.run/1`, `ExUnit.Case.__after_compile__/2`).
    * `ExUnit.Runner.run_module/5` gets the tests from `module.__ex_unit__()`, an
      `%ExUnit.TestModule{}` with `:name`, `:tests`, `:tags` and `:setup_all?`.
    * The runner calls callbacks on the names inside those structs, not on the
      module it was given: `setup_all` on `test_module.name`, `setup` and the test
      function on `test.module`. A proxy that returns the real module's struct with
      fewer tests therefore runs the real callbacks, and results, tags, file and
      line still name the real module.
    * Async modules start in the order they were registered, `max_cases` at a time.

  ## Consequences

    * `setup_all` (and its `on_exit`) runs once per shard instead of once per
      module. A module is only split when that is safe as far as Cook can tell;
      see `split_reason/3`. `@moduletag cook_split: false` opts a module out.
    * ExUnit reports `module_started` / `module_finished` once per shard, with the
      real module's name.
    * A `file:line` filter picks the closest test among the tests of the module it
      is given, so a split module would match one test per shard. Runs with line
      references are never split.

  Proxy modules are generic and reused: `Cook.Agent.Shards.Slot<N>` reads its
  content from a table that `install/2` replaces for every run, so nothing is
  compiled per run and a reloaded test file needs no refresh.
  """

  @table_key {__MODULE__, :table}
  @modes [:test, :packed, :off]

  @doc """
  Turns the selected test modules into what `ExUnit.run/1` should be given.

  `modules` is a list of `{module, file}`. Options: `:shard` (`:test`, one shard
  per test; `:packed`, as few shards per module as fit under the slowest test;
  `:off`), `:durations` (`[{module_name, test_name, ms}]`), `:module_order`
  (module names, the tie-break when durations are unknown) and `:line_refs?`.

  Returns `{run_modules, scheduling}`. Never raises: on any failure the real
  modules come back in `:module_order` and `scheduling.fallback` says why.
  """
  def prepare(modules, opts, order_fallback) do
    do_prepare(modules, opts)
  catch
    kind, reason ->
      message = Exception.format_banner(kind, reason, __STACKTRACE__)

      {order_fallback.(Enum.map(modules, &elem(&1, 0))),
       %{
         granularity: "module",
         mode: "off",
         units: length(modules),
         unsplit: [],
         fallback: message
       }}
  end

  defp do_prepare(modules, opts) do
    mode = mode(opts)
    line_refs? = Keyword.get(opts, :line_refs?, false)
    described = Enum.map(modules, fn {module, file} -> describe(module, file, line_refs?) end)

    durations =
      for {module, name, ms} <- Keyword.get(opts, :durations, []), into: %{} do
        {{module, name}, ms}
      end

    units = plan(described, durations, mode: mode, order: Keyword.get(opts, :module_order, []))
    run_modules = install(units, Map.new(described, &{&1.module, &1}))
    {run_modules, summary(units, described, mode)}
  end

  defp mode(opts) do
    mode = Keyword.get(opts, :shard, :packed)
    if mode in @modes, do: mode, else: :off
  end

  @doc """
  Reads what the planner needs from a loaded test module. `split` is `:ok` or
  `{:no, reason}`; anything unexpected makes the module unsplittable.
  """
  def describe(module, file, line_refs? \\ false) do
    test_module = module.__ex_unit__()
    config = module.__ex_unit__(:config)
    tests = for test <- test_module.tests, do: Atom.to_string(test.name)

    %{
      module: module,
      name: inspect(module),
      tests: tests,
      split: split_reason(test_module, config, %{source: source(file), line_refs?: line_refs?}),
      test_module: test_module,
      config: config
    }
  catch
    _kind, _reason ->
      %{
        module: module,
        name: inspect(module),
        tests: [],
        split: {:no, "unreadable"},
        test_module: nil,
        config: nil
      }
  end

  @doc """
  Decides whether a module may be split, conservatively.

  A module is split only when it is `async: true`, has no `:group` and no
  `:parameterize`, did not opt out, the run has no `file:line` references, and
  its test file does not define a `setup_all` of its own. A `setup_all` that
  comes from a case template (for example the Playwright case, which launches a
  browser per module) is accepted: a template already runs it once per module
  for many modules at the same time, so once per shard is the same pattern.
  State a module builds in its own `setup_all` may be meant to be shared by its
  tests, so those modules stay whole.
  """
  def split_reason(test_module, config, %{source: source, line_refs?: line_refs?}) do
    cond do
      not is_list(test_module.tests) -> {:no, "unreadable"}
      config.async? != true -> {:no, "async: false"}
      config.group != nil -> {:no, "group"}
      config.parameterize != nil -> {:no, "parameterize"}
      test_module.tags[:cook_split] == false -> {:no, "cook_split: false"}
      line_refs? -> {:no, "file:line run"}
      length(test_module.tests) < 2 -> {:no, "single test"}
      test_module.setup_all? and source == nil -> {:no, "setup_all, source unreadable"}
      test_module.setup_all? and own_setup_all?(source) -> {:no, "own setup_all"}
      true -> :ok
    end
  end

  @doc """
  True when test file source mentions `setup_all` outside of a comment.
  """
  def own_setup_all?(source) do
    source
    |> String.split("\n")
    |> Enum.any?(fn line ->
      line |> String.replace(~r/#.*$/, "") |> String.contains?("setup_all")
    end)
  end

  defp source(file) do
    case File.read(file) do
      {:ok, source} -> source
      {:error, _reason} -> nil
    end
  end

  @doc """
  The pure planner. `described` is a list of `%{module:, name:, tests: [name],
  split: :ok | {:no, reason}}`; `durations` maps `{module_name, test_name}` to the
  last recorded milliseconds.

  Returns units `%{module:, name:, tests: :all | [name], est_ms:}`, longest
  estimate first. Ties (unknown durations count as 0) keep `opts[:order]`, then
  the given order. A unit with `tests: :all` is the real module.

    * `mode: :test` - one unit per test of every splittable module
    * `mode: :packed` - the tests of a module are packed first-fit, longest
      first, into as few units as stay at or under the slowest known test of the
      run; a module with a test of unknown duration gets one unit per test
    * `mode: :off` - one unit per module
  """
  def plan(described, durations, opts \\ []) do
    mode = Keyword.get(opts, :mode, :packed)
    rank = opts |> Keyword.get(:order, []) |> Enum.with_index() |> Map.new()
    unranked = map_size(rank)

    capacity =
      for(%{name: name, tests: tests} <- described, test <- tests, do: durations[{name, test}])
      |> Enum.reject(&is_nil/1)
      |> Enum.max(fn -> 0 end)

    described
    |> Enum.with_index()
    |> Enum.flat_map(fn {entry, index} ->
      groups = groups(entry, durations, mode, capacity)

      for {tests, position} <- Enum.with_index(groups) do
        names = if tests == :all, do: entry.tests, else: tests
        est_ms = names |> Enum.map(&Map.get(durations, {entry.name, &1}, 0)) |> Enum.sum()
        key = {-est_ms, Map.get(rank, entry.name, unranked + index), index, position}
        {key, %{module: entry.module, name: entry.name, tests: tests, est_ms: est_ms}}
      end
    end)
    |> Enum.sort_by(&elem(&1, 0))
    |> Enum.map(&elem(&1, 1))
  end

  defp groups(%{split: :ok, tests: [_one, _two | _rest] = tests}, _durations, :test, _capacity) do
    Enum.map(tests, &[&1])
  end

  defp groups(%{split: :ok, tests: [_one, _two | _rest]} = entry, durations, :packed, capacity) do
    timed = Enum.map(entry.tests, &{&1, durations[{entry.name, &1}]})

    if Enum.any?(timed, fn {_test, ms} -> ms == nil end) do
      Enum.map(entry.tests, &[&1])
    else
      case pack(timed, capacity) do
        [_single] -> [:all]
        bins -> Enum.map(bins, fn bin -> Enum.filter(entry.tests, &(&1 in bin)) end)
      end
    end
  end

  defp groups(_entry, _durations, _mode, _capacity), do: [:all]

  @doc """
  First-fit decreasing: packs `[{item, size}]` into bins of `capacity`, returning
  the bins as lists of items. An item larger than the capacity gets its own bin.
  """
  def pack(items, capacity) do
    items
    |> Enum.sort_by(fn {_item, size} -> -size end)
    |> Enum.reduce([], fn {item, size}, bins ->
      case Enum.find_index(bins, fn {used, _items} -> used + size <= capacity end) do
        nil ->
          bins ++ [{size, [item]}]

        index ->
          List.update_at(bins, index, fn {used, items} -> {used + size, [item | items]} end)
      end
    end)
    |> Enum.map(fn {_used, items} -> Enum.reverse(items) end)
  end

  @doc """
  What the verdict says about scheduling: plain data.
  """
  def summary(units, described, mode) do
    split = units |> Enum.reject(&(&1.tests == :all)) |> Enum.map(& &1.name) |> Enum.uniq()

    unsplit =
      for %{split: {:no, reason}, name: name} <- described,
          reason not in ["single test", "async: false"] do
        %{module: name, reason: reason}
      end

    %{
      granularity: if(split == [], do: "module", else: "test"),
      mode: Atom.to_string(mode),
      units: length(units),
      split_modules: length(split),
      unsplit: unsplit
    }
  end

  ## Proxy modules

  # Assigns a slot module to every unit that is a subset of a module and
  # publishes the table the slots read. Returns the modules for `ExUnit.run/1`.
  defp install(units, described) do
    {modules, table, _next} =
      Enum.reduce(units, {[], %{}, 1}, fn
        %{tests: :all, module: module}, {modules, table, next} ->
          {[module | modules], table, next}

        %{tests: names, module: module}, {modules, table, next} ->
          %{test_module: test_module, config: config} = Map.fetch!(described, module)
          wanted = MapSet.new(names)

          tests =
            Enum.filter(test_module.tests, &MapSet.member?(wanted, Atom.to_string(&1.name)))

          if length(tests) != length(names), do: raise("shard of #{inspect(module)} lost tests")

          slot = slot(next)
          entry = %{test_module: %{test_module | tests: tests}, config: config}
          {[slot | modules], Map.put(table, slot, entry), next + 1}
      end)

    :persistent_term.put(@table_key, table)
    Enum.reverse(modules)
  end

  defp slot(number) do
    name = Module.concat(__MODULE__, "Slot#{number}")

    if not (Code.ensure_loaded?(name) and function_exported?(name, :__ex_unit__, 1)) do
      body =
        quote do
          @moduledoc false
          def __ex_unit__, do: Cook.Agent.Shards.fetch(__MODULE__, :test_module)
          def __ex_unit__(:config), do: Cook.Agent.Shards.fetch(__MODULE__, :config)
        end

      {:module, ^name, _binary, _result} = Module.create(name, body, Macro.Env.location(__ENV__))
    end

    name
  end

  @doc false
  def fetch(slot, key) do
    @table_key |> :persistent_term.get(%{}) |> Map.fetch!(slot) |> Map.fetch!(key)
  end
end
