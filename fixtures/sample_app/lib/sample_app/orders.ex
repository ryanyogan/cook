defmodule SampleApp.Orders do
  @moduledoc """
  The Orders context: users buying products out of the catalog's stock.
  """

  import Ecto.Query, warn: false

  alias SampleApp.Accounts.Scope
  alias SampleApp.Accounts.User
  alias SampleApp.Catalog.Product
  alias SampleApp.Orders.Order
  alias SampleApp.Orders.Workers.ConfirmOrder
  alias SampleApp.Repo

  @doc """
  Lists the scope user's orders, newest first, with their product preloaded.
  """
  def list_orders(%Scope{user: %User{id: user_id}}) do
    Order
    |> where([o], o.user_id == ^user_id)
    |> order_by([o], desc: o.id)
    |> preload(:product)
    |> Repo.all()
  end

  @doc """
  Order count, units and total spent for the scope user.
  """
  def order_totals(%Scope{user: %User{id: user_id}}) do
    Order
    |> where([o], o.user_id == ^user_id)
    |> select([o], %{
      orders: count(o.id),
      units: coalesce(sum(o.quantity), 0),
      total_cents: coalesce(sum(o.total_cents), 0)
    })
    |> Repo.one()
  end

  def change_order(%Order{} = order \\ %Order{}, attrs \\ %{}) do
    Order.changeset(order, attrs)
  end

  @doc """
  Places an order for `product`, taking the quantity out of its stock.

  The order starts as `"pending"`; a `ConfirmOrder` job confirms it. Returns
  the order as it is once the job has been enqueued.
  """
  def create_order(%Scope{user: %User{id: user_id}}, %Product{} = product, attrs) do
    changeset = Order.changeset(%Order{user_id: user_id, product_id: product.id}, attrs)

    result =
      Repo.transact(fn ->
        with {:ok, order} <- Ecto.Changeset.apply_action(changeset, :insert),
             :ok <- take_stock(product, order.quantity, changeset) do
          changeset
          |> Ecto.Changeset.put_change(:total_cents, order.quantity * product.price_cents)
          |> Repo.insert()
        end
      end)

    with {:ok, order} <- result do
      {:ok, _job} = Oban.insert(ConfirmOrder.new(%{order_id: order.id}))
      {:ok, Repo.get!(Order, order.id)}
    end
  end

  # Decrements in the database, so two concurrent orders cannot oversell.
  defp take_stock(%Product{id: product_id}, quantity, changeset) do
    query = from p in Product, where: p.id == ^product_id and p.stock >= ^quantity

    case Repo.update_all(query, inc: [stock: -quantity]) do
      {1, _} -> :ok
      {0, _} -> {:error, out_of_stock_error(changeset, Repo.get!(Product, product_id).stock)}
    end
  end

  defp out_of_stock_error(changeset, 0) do
    changeset
    |> Ecto.Changeset.add_error(:quantity, "is not available, the product is out of stock")
    |> Map.put(:action, :insert)
  end

  defp out_of_stock_error(changeset, stock) do
    changeset
    |> Ecto.Changeset.add_error(:quantity, "exceeds the stock, only %{stock} left", stock: stock)
    |> Map.put(:action, :insert)
  end

  @doc """
  Marks a pending order as confirmed. Does nothing for any other order.
  """
  def confirm_order(order_id) do
    query = from o in Order, where: o.id == ^order_id and o.status == "pending"
    {count, _} = Repo.update_all(query, set: [status: "confirmed"])
    count
  end
end
