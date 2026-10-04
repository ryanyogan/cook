defmodule SampleAppWeb.Features.OrderHistoryTest do
  use SampleAppWeb.FeatureCase, async: true

  setup :register_and_log_in_user

  test "a placed order is confirmed by the background job and listed", %{conn: conn} do
    product = product_fixture(price_cents: 900, stock: 5)

    conn
    |> visit_live(~p"/products/#{product}")
    |> fill_in("Quantity", with: "3")
    |> click_button("Place order")
    |> assert_has("#order-confirmation")
    |> click_link("View your orders")
    |> assert_path(~p"/orders")
    |> assert_has("#orders li", text: product.name)
    |> assert_has("#orders [data-role=quantity]", text: "3", exact: true)
    |> assert_has("#orders [data-role=total]", text: "$27.00")
    |> assert_has("#orders [data-role=status]", text: "confirmed")
  end

  test "only the signed-in user's own orders are listed", %{conn: conn, user: user} do
    mine = product_fixture(name: "Mine #{unique_tag()}")
    theirs = product_fixture(name: "Theirs #{unique_tag()}")
    order_fixture(user, mine)
    order_fixture(user_fixture(), theirs)

    conn
    |> visit_live(~p"/orders")
    |> assert_has("#orders li", text: mine.name)
    |> refute_has("#orders li", text: theirs.name)
  end

  # SLOW on purpose (about 4 s): the export itself takes 3.6 s on the server.
  @tag :slow
  test "exporting the order history sums up every order", %{conn: conn, user: user} do
    order_fixture(user, product_fixture(price_cents: 1000), 3)
    order_fixture(user, product_fixture(price_cents: 250), 2)

    conn
    |> visit_live(~p"/orders")
    |> click_button("Export order history")
    |> assert_has("#export-running")
    |> assert_has("#export-result", text: "2 orders, 5 units", timeout: 8_000)
    |> assert_has("#export-result", text: "$35.00 in total")
  end
end
