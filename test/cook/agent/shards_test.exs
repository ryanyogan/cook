defmodule Cook.Agent.ShardsTest do
  # Not async: `prepare/3` publishes the shard table in a global `:persistent_term`.
  use ExUnit.Case, async: false

  alias Cook.Agent.Shards
  alias Cook.FakeTestModule

  @async %{async?: true, group: nil, parameterize: nil}
  @context %{source: "", line_refs?: false}

  defp entry(name, tests, split \\ :ok) do
    %{module: String.to_atom(name), name: name, tests: tests, split: split}
  end

  defp shape(units), do: Enum.map(units, &{&1.name, &1.tests, &1.est_ms})

  defp test_module(names, overrides \\ %{}) do
    Map.merge(
      %{
        name: FakeTestModule,
        setup_all?: false,
        tags: %{},
        tests: Enum.map(names, &%{name: &1, module: FakeTestModule})
      },
      overrides
    )
  end

  describe "plan/3" do
    test "mode :test gives one unit per test of a splittable module, longest first" do
      described = [entry("A", ["a1", "a2", "a3"]), entry("B", ["b1"])]

      durations = %{
        {"A", "a1"} => 100,
        {"A", "a2"} => 4_000,
        {"A", "a3"} => 700,
        {"B", "b1"} => 900
      }

      assert described |> Shards.plan(durations, mode: :test) |> shape() == [
               {"A", ["a2"], 4_000},
               {"B", :all, 900},
               {"A", ["a3"], 700},
               {"A", ["a1"], 100}
             ]
    end

    test "modules that may not be split stay whole and are ordered by their total" do
      described = [
        entry("Sync", ["s1", "s2"], {:no, "async: false"}),
        entry("Own", ["o1", "o2"], {:no, "own setup_all"}),
        entry("A", ["a1", "a2"])
      ]

      durations = %{
        {"Sync", "s1"} => 10,
        {"Sync", "s2"} => 20,
        {"Own", "o1"} => 500,
        {"Own", "o2"} => 600,
        {"A", "a1"} => 800,
        {"A", "a2"} => 50
      }

      assert described |> Shards.plan(durations, mode: :test) |> shape() == [
               {"Own", :all, 1_100},
               {"A", ["a1"], 800},
               {"A", ["a2"], 50},
               {"Sync", :all, 30}
             ]
    end

    test "mode :packed only splits a module that is longer than the slowest test" do
      described = [entry("Long", ["slow", "x", "y"]), entry("Short", ["p", "q", "r"])]

      durations = %{
        {"Long", "slow"} => 4_000,
        {"Long", "x"} => 600,
        {"Long", "y"} => 500,
        {"Short", "p"} => 1_000,
        {"Short", "q"} => 1_000,
        {"Short", "r"} => 1_000
      }

      assert described |> Shards.plan(durations, mode: :packed) |> shape() == [
               {"Long", ["slow"], 4_000},
               {"Short", :all, 3_000},
               {"Long", ["x", "y"], 1_100}
             ]
    end

    test "mode :packed keeps the tests of a shard in file order" do
      described = [entry("A", ["t1", "t2", "t3", "t4"])]

      durations = %{
        {"A", "t1"} => 200,
        {"A", "t2"} => 1_000,
        {"A", "t3"} => 300,
        {"A", "t4"} => 500
      }

      assert described |> Shards.plan(durations, mode: :packed) |> shape() == [
               {"A", ["t2"], 1_000},
               {"A", ["t1", "t3", "t4"], 1_000}
             ]
    end

    test "mode :packed splits a module with a test of unknown duration per test" do
      described = [entry("A", ["known", "new"]), entry("B", ["b1", "b2"])]
      durations = %{{"A", "known"} => 300, {"B", "b1"} => 100, {"B", "b2"} => 100}

      assert described |> Shards.plan(durations, mode: :packed) |> shape() == [
               {"A", ["known"], 300},
               {"B", :all, 200},
               {"A", ["new"], 0}
             ]
    end

    test "mode :off keeps every module whole" do
      described = [entry("A", ["a1", "a2"]), entry("B", ["b1", "b2"])]
      durations = %{{"B", "b1"} => 5}

      assert described |> Shards.plan(durations, mode: :off) |> shape() == [
               {"B", :all, 5},
               {"A", :all, 0}
             ]
    end

    test "without durations the given module order, then the listed order, decides" do
      described = [entry("A", ["a1", "a2"]), entry("B", ["b1"]), entry("C", ["c1"])]

      assert described |> Shards.plan(%{}, mode: :test, order: ["C"]) |> shape() == [
               {"C", :all, 0},
               {"A", ["a1"], 0},
               {"A", ["a2"], 0},
               {"B", :all, 0}
             ]
    end
  end

  test "pack/2 is first-fit decreasing and gives an oversized item its own bin" do
    assert Shards.pack([{:a, 5}, {:b, 9}, {:c, 3}, {:d, 2}, {:e, 12}], 10) ==
             [[:e], [:b], [:a, :c, :d]]

    assert Shards.pack([], 10) == []
  end

  describe "split_reason/3" do
    test "an async module with several tests is split" do
      assert Shards.split_reason(test_module([:a, :b]), @async, @context) == :ok
    end

    test "sync, grouped, parameterized, opted-out and single-test modules are not" do
      two = test_module([:a, :b])

      assert Shards.split_reason(two, %{@async | async?: false}, @context) ==
               {:no, "async: false"}

      assert Shards.split_reason(two, %{@async | group: :db}, @context) == {:no, "group"}

      assert Shards.split_reason(two, %{@async | parameterize: [%{a: 1}]}, @context) ==
               {:no, "parameterize"}

      assert Shards.split_reason(%{two | tags: %{cook_split: false}}, @async, @context) ==
               {:no, "cook_split: false"}

      assert Shards.split_reason(test_module([:a]), @async, @context) == {:no, "single test"}
    end

    test "a run with file:line references is never split" do
      assert Shards.split_reason(test_module([:a, :b]), @async, %{@context | line_refs?: true}) ==
               {:no, "file:line run"}
    end

    test "setup_all from a case template is accepted, the module's own is not" do
      with_setup_all = test_module([:a, :b], %{setup_all?: true})
      template = "use MyApp.FeatureCase, async: true\n# no setup_all here\n"
      own = "use MyApp.FeatureCase\n\n  setup_all do\n    %{user: create()}\n  end\n"

      assert Shards.split_reason(with_setup_all, @async, %{@context | source: template}) == :ok

      assert Shards.split_reason(with_setup_all, @async, %{@context | source: own}) ==
               {:no, "own setup_all"}

      assert Shards.split_reason(with_setup_all, @async, %{@context | source: nil}) ==
               {:no, "setup_all, source unreadable"}
    end
  end

  describe "prepare/3" do
    test "proxy modules expose their share of the real module's tests and its config" do
      FakeTestModule.put(test_module([:"test a", :"test b", :"test c"]), @async)

      {modules, scheduling} =
        Shards.prepare([{FakeTestModule, "nofile"}], [shard: :test], &Function.identity/1)

      assert [_one, _two, _three] = modules
      refute FakeTestModule in modules

      assert Enum.map(modules, & &1.__ex_unit__().tests) == [
               [%{name: :"test a", module: FakeTestModule}],
               [%{name: :"test b", module: FakeTestModule}],
               [%{name: :"test c", module: FakeTestModule}]
             ]

      # Everything else is the real module's, so callbacks and results point at it.
      assert Enum.all?(modules, &(&1.__ex_unit__().name == FakeTestModule))
      assert Enum.all?(modules, &(&1.__ex_unit__(:config) == @async))

      assert scheduling == %{
               granularity: "test",
               mode: "test",
               units: 3,
               split_modules: 1,
               unsplit: []
             }
    end

    test "packing by recorded durations, and slots are reused between runs" do
      FakeTestModule.put(test_module([:"test a", :"test b", :"test c"]), @async)
      name = inspect(FakeTestModule)
      durations = [{name, "test a", 100}, {name, "test b", 900}, {name, "test c", 200}]
      opts = [shard: :packed, durations: durations]

      {[first, second], scheduling} =
        Shards.prepare([{FakeTestModule, "nofile"}], opts, &Function.identity/1)

      assert Enum.map(first.__ex_unit__().tests, & &1.name) == [:"test b"]
      assert Enum.map(second.__ex_unit__().tests, & &1.name) == [:"test a", :"test c"]
      assert scheduling.units == 2

      FakeTestModule.put(test_module([:"test only", :"test other"]), @async)
      {[again, _other], _} = Shards.prepare([{FakeTestModule, "nofile"}], [shard: :test], & &1)

      assert again == first
      assert Enum.map(again.__ex_unit__().tests, & &1.name) == [:"test only"]
    end

    test "a module that cannot be split is run as itself and named in the summary" do
      FakeTestModule.put(test_module([:"test a", :"test b"]), %{@async | group: :db})

      assert {[FakeTestModule], scheduling} =
               Shards.prepare([{FakeTestModule, "nofile"}], [], &Function.identity/1)

      assert scheduling.granularity == "module"
      assert scheduling.unsplit == [%{module: inspect(FakeTestModule), reason: "group"}]
    end

    test "a module whose internals cannot be read is run whole, not failed" do
      FakeTestModule.put(%{unexpected: :shape}, @async)

      assert {[FakeTestModule], scheduling} =
               Shards.prepare([{FakeTestModule, "nofile"}], [], &Function.identity/1)

      assert scheduling.unsplit == [%{module: inspect(FakeTestModule), reason: "unreadable"}]
    end

    test "if planning itself fails, the modules come back in the caller's order" do
      FakeTestModule.put(test_module([:"test a", :"test b"]), @async)

      {modules, scheduling} =
        Shards.prepare(
          [{FakeTestModule, "nofile"}, {String, "nofile"}],
          [durations: :not_a_list],
          &Enum.reverse/1
        )

      assert modules == [String, FakeTestModule]
      assert scheduling.granularity == "module"
      assert scheduling.fallback =~ "Protocol.UndefinedError"
    end
  end
end
