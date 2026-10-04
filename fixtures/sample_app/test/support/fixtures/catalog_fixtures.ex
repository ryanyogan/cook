defmodule SampleApp.CatalogFixtures do
  @moduledoc """
  Test helpers for creating entities via the `SampleApp.Catalog` context.
  """

  alias SampleApp.AccountsFixtures
  alias SampleApp.Catalog

  def unique_product_name, do: "Widget #{System.unique_integer([:positive])}"

  def product_fixture(attrs \\ %{}) do
    attrs =
      Enum.into(attrs, %{
        name: unique_product_name(),
        description: "A dependable widget.",
        price_cents: 1250,
        stock: 10
      })

    {:ok, product} = Catalog.create_product(AccountsFixtures.user_scope_fixture(), attrs)
    product
  end
end
