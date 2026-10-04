defmodule SampleAppWeb.Features.ProductManagementTest do
  use SampleAppWeb.FeatureCase, async: true

  setup :register_and_log_in_user

  test "a signed-in user creates a product", %{conn: conn} do
    name = "Toaster #{unique_tag()}"

    conn
    |> visit_live(~p"/products/new")
    |> fill_in("Name", with: name)
    |> fill_in("Description", with: "Two slots, one dial.")
    |> fill_in("Price (cents)", with: "4550")
    |> fill_in("Stock", with: "12")
    |> click_button("Save product")
    |> assert_has("#flash-info", text: "Product created.")
    |> assert_has("#product-name", text: name)
    |> assert_has("#product-price", text: "$45.50")
    |> assert_has("#product-stock", text: "12 in stock")
  end

  test "invalid product details are rejected with messages", %{conn: conn} do
    conn
    |> visit_live(~p"/products/new")
    |> fill_in("Name", with: "x")
    |> fill_in("Stock", with: "-1")
    |> assert_has("#product-form", text: "should be at least 2 character(s)")
    |> assert_has("#product-form", text: "must be greater than or equal to 0")
    |> click_button("Save product")
    |> assert_has("#product-form", text: "can't be blank")
    |> assert_path(~p"/products/new")
  end

  test "a signed-in user edits a product", %{conn: conn} do
    product = product_fixture(stock: 10)
    new_name = "Renamed #{unique_tag()}"

    conn
    |> visit_live(~p"/products/#{product}")
    |> click_link("Edit")
    |> assert_has("h1", text: "Edit product")
    |> wait_for_live()
    |> fill_in("Name", with: new_name)
    |> fill_in("Stock", with: "3")
    |> click_button("Save product")
    |> assert_has("#flash-info", text: "Product updated.")
    |> assert_has("#product-name", text: new_name)
    |> assert_has("#product-stock", text: "3 in stock")
  end

  test "a signed-in user deletes a product", %{conn: conn} do
    product = product_fixture()

    conn
    |> visit_live(~p"/products/#{product}")
    |> click_button("Delete")
    |> assert_has("#flash-info", text: "Product deleted.")
    |> assert_path(~p"/products")
    |> fill_in("Search products", with: product.name)
    |> assert_has("#products-empty", text: "No products match your search.")
  end
end
