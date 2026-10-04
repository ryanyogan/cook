defmodule SampleApp.OrdersFixtures do
  @moduledoc """
  Test helpers for creating entities via the `SampleApp.Orders` context.
  """

  alias SampleApp.Accounts.Scope
  alias SampleApp.Orders

  @doc """
  Places an order as `user`. Jobs run inline in tests, so it comes back confirmed.
  """
  def order_fixture(user, product, quantity \\ 1) do
    {:ok, order} = Orders.create_order(Scope.for_user(user), product, %{quantity: quantity})
    order
  end
end
