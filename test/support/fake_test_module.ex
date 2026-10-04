defmodule Cook.FakeTestModule do
  @moduledoc """
  Stands in for a compiled ExUnit test module in `Cook.Agent.Shards` tests: it
  exports the two `__ex_unit__` functions the runner uses, with plain maps in
  place of ExUnit's structs. What they return is set per test with `put/2`.
  """

  def put(test_module, config) do
    Process.put(__MODULE__, {test_module, config})
  end

  def __ex_unit__, do: elem(Process.get(__MODULE__), 0)
  def __ex_unit__(:config), do: elem(Process.get(__MODULE__), 1)
end
