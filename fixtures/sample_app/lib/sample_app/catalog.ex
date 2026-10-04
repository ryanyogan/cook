defmodule SampleApp.Catalog do
  @moduledoc """
  The Catalog context: products that can be browsed and ordered.
  """

  import Ecto.Query, warn: false

  alias SampleApp.Accounts.Scope
  alias SampleApp.Accounts.User
  alias SampleApp.Catalog.Product
  alias SampleApp.Repo

  @list_limit 50

  @doc """
  Lists the newest products whose name contains `search` (case-insensitive).
  """
  def list_products(search \\ "") do
    Product
    |> filter_by_name(String.trim(search || ""))
    |> order_by([p], desc: p.id)
    |> limit(@list_limit)
    |> Repo.all()
  end

  defp filter_by_name(query, ""), do: query

  defp filter_by_name(query, search) do
    pattern = "%" <> String.replace(search, ~r/([\\%_])/, "\\\\\\1") <> "%"
    where(query, [p], ilike(p.name, ^pattern))
  end

  def get_product!(id), do: Repo.get!(Product, id)

  def create_product(%Scope{user: %User{}}, attrs) do
    %Product{}
    |> Product.changeset(attrs)
    |> Repo.insert()
  end

  def update_product(%Scope{user: %User{}}, %Product{} = product, attrs) do
    product
    |> Product.changeset(attrs)
    |> Repo.update()
  end

  def delete_product(%Scope{user: %User{}}, %Product{} = product) do
    Repo.delete(product)
  end

  def change_product(%Product{} = product, attrs \\ %{}) do
    Product.changeset(product, attrs)
  end

  @doc """
  Imports products from CSV-style text, one `name,price_cents,stock` per line.

  Either every line is imported or none is. Returns `{:ok, count}` or
  `{:error, message}` naming the first bad line.
  """
  def import_products(%Scope{user: %User{}} = scope, text) when is_binary(text) do
    lines =
      text
      |> String.split(["\r\n", "\n"])
      |> Enum.map(&String.trim/1)
      |> Enum.reject(&(&1 == ""))

    if lines == [] do
      {:error, "Nothing to import"}
    else
      Repo.transact(fn -> import_lines(scope, lines) end)
    end
  end

  defp import_lines(scope, lines) do
    lines
    |> Enum.with_index(1)
    |> Enum.reduce_while({:ok, 0}, fn {line, number}, {:ok, count} ->
      with [name, price_cents, stock] <- line |> String.split(",") |> Enum.map(&String.trim/1),
           attrs = %{name: name, price_cents: price_cents, stock: stock},
           {:ok, _product} <- create_product(scope, attrs) do
        {:cont, {:ok, count + 1}}
      else
        _ -> {:halt, {:error, "Line #{number} is invalid: #{line}"}}
      end
    end)
  end
end
