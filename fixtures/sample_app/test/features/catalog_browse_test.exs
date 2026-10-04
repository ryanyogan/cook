defmodule SampleAppWeb.Features.CatalogBrowseTest do
  use SampleAppWeb.FeatureCase, async: true

  test "the catalog lists a product with its price and stock", %{conn: conn} do
    product = product_fixture(name: "Kettle #{unique_tag()}", price_cents: 1999, stock: 7)

    conn
    |> visit_live(~p"/products")
    |> assert_has("#products-#{product.id}", text: product.name)
    |> assert_has("#products-#{product.id}", text: "$19.99")
    |> assert_has("#products-#{product.id}", text: "7 in stock")
  end

  test "searching narrows the list to matching names", %{conn: conn} do
    tag = unique_tag()
    lamp = product_fixture(name: "Lamp #{tag}")
    chair = product_fixture(name: "Chair #{tag}")

    conn
    |> visit_live(~p"/products")
    |> assert_has("#products-#{chair.id}")
    |> fill_in("Search products", with: "lamp #{tag}")
    |> refute_has("#products-#{chair.id}")
    |> assert_has("#products-#{lamp.id}", text: lamp.name)
  end

  test "a search that matches nothing says so", %{conn: conn} do
    product = product_fixture()

    conn
    |> visit_live(~p"/products")
    |> assert_has("#products-#{product.id}")
    |> fill_in("Search products", with: "no-such-product-#{unique_tag()}")
    |> assert_has("#products-empty", text: "No products match your search.")
    |> refute_has("#products-#{product.id}")
  end

  test "a guest opens a product from the list and sees its details", %{conn: conn} do
    product =
      product_fixture(
        name: "Teapot #{unique_tag()}",
        description: "Holds exactly four cups.",
        price_cents: 3400,
        stock: 2
      )

    conn
    |> visit_live(~p"/products")
    |> click_link(product.name)
    |> assert_path(~p"/products/#{product}")
    |> assert_has("#product-name", text: product.name)
    |> assert_has("#product-price", text: "$34.00")
    |> assert_has("#product-stock", text: "2 in stock")
    |> assert_has("#product-description", text: "Holds exactly four cups.")
    |> assert_has("#login-to-order", text: "Sign in to order")
    |> refute_has("#delete-product")
  end
end
