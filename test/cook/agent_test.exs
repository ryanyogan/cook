defmodule Cook.AgentTest do
  use ExUnit.Case, async: true

  alias Cook.Agent

  describe "order_modules/2" do
    test "puts named modules first, in the requested order" do
      assert Agent.order_modules([A, B, C, D], ["C", "A"]) == [C, A, B, D]
    end

    test "keeps the existing order when nothing is requested" do
      assert Agent.order_modules([B, A], []) == [B, A]
    end

    test "ignores names that are not loaded" do
      assert Agent.order_modules([A, B], ["Missing", "B"]) == [B, A]
    end
  end

  describe "parse_test/1" do
    test "splits file and line" do
      assert Agent.parse_test("test/a_test.exs:12") == {"test/a_test.exs", 12}
    end

    test "leaves a plain path alone" do
      assert Agent.parse_test("test/a_test.exs") == {"test/a_test.exs", nil}
      assert Agent.parse_test("test/features") == {"test/features", nil}
    end
  end

  describe "select/2" do
    @known ["test/features/a_test.exs", "test/features/b_test.exs", "test/other/c_test.exs"]

    test "no references selects everything, without line filters" do
      assert Agent.select([], @known) == {:ok, @known, []}
    end

    test "a file selects that file" do
      assert Agent.select(["test/features/b_test.exs"], @known) ==
               {:ok, ["test/features/b_test.exs"], []}
    end

    test "a directory selects the files below it" do
      assert Agent.select(["test/features"], @known) ==
               {:ok, ["test/features/a_test.exs", "test/features/b_test.exs"], []}
    end

    test "file:line references are kept as line filters" do
      assert Agent.select(["test/features/a_test.exs:4", "test/features/a_test.exs:9"], @known) ==
               {:ok, ["test/features/a_test.exs"],
                ["test/features/a_test.exs:4", "test/features/a_test.exs:9"]}
    end

    test "whole files mixed with lines stay whole" do
      assert Agent.select(["test/features/a_test.exs:4", "test/other"], @known) ==
               {:ok, ["test/features/a_test.exs", "test/other/c_test.exs"],
                ["test/features/a_test.exs:4", "test/other/c_test.exs"]}
    end

    test "unknown references are an error" do
      assert Agent.select(["test/nope_test.exs:3", "test/features"], @known) ==
               {:error, {:unknown_tests, ["test/nope_test.exs:3"]}}
    end
  end

  describe "discover/1" do
    @tag :tmp_dir
    test "finds *_test.exs files under directories, sorted", %{tmp_dir: dir} do
      File.mkdir_p!(Path.join(dir, "nested"))

      for name <- ["b_test.exs", "nested/a_test.exs", "helper.exs"],
          do: File.write!(Path.join(dir, name), "")

      assert Agent.discover([dir]) == [
               Path.join(dir, "b_test.exs"),
               Path.join(dir, "nested/a_test.exs")
             ]

      assert Agent.discover([Path.join(dir, "b_test.exs"), Path.join(dir, "gone_test.exs")]) == [
               Path.join(dir, "b_test.exs")
             ]
    end
  end
end
