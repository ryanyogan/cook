defmodule SampleAppWeb.Features.OrderingTest do
  use SampleAppWeb.FeatureCase, async: true

  setup :register_and_log_in_user

  test "ordering takes the quantity out of the product's stock", %{conn: conn} do
    product = product_fixture(price_cents: 1250, stock: 5)

    conn
    |> visit_live(~p"/products/#{product}")
    |> fill_in("Quantity", with: "2")
    |> click_button("Place order")
    |> assert_has("#flash-info", text: "Order placed.")
    |> assert_has("#order-confirmation", text: "2 for $25.00")
    |> assert_has("#product-stock", text: "3 in stock")

    assert SampleApp.Catalog.get_product!(product.id).stock == 3
  end

  test "ordering more than the stock is rejected", %{conn: conn} do
    product = product_fixture(stock: 2)

    conn
    |> visit_live(~p"/products/#{product}")
    |> fill_in("Quantity", with: "3")
    |> click_button("Place order")
    |> assert_has("#order-form", text: "exceeds the stock, only 2 left")
    |> assert_has("#product-stock", text: "2 in stock")
    |> refute_has("#order-confirmation")
  end

  test "an out-of-stock product cannot be ordered", %{conn: conn} do
    product = product_fixture(stock: 0)

    conn
    |> visit_live(~p"/products/#{product}")
    |> assert_has("#product-stock", text: "Out of stock")
    |> fill_in("Quantity", with: "1")
    |> click_button("Place order")
    |> assert_has("#order-form", text: "the product is out of stock")
    |> refute_has("#order-confirmation")
  end

  test "a quantity of zero is rejected", %{conn: conn} do
    product = product_fixture(stock: 4)

    conn
    |> visit_live(~p"/products/#{product}")
    |> fill_in("Quantity", with: "0")
    |> click_button("Place order")
    |> assert_has("#order-form", text: "must be greater than 0")
    |> assert_has("#product-stock", text: "4 in stock")
  end
end
