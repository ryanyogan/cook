defmodule SampleAppWeb.Features.ReportsTest do
  use SampleAppWeb.FeatureCase, async: true

  # SLOW on purpose (about 1.5 s): generating the report takes 1 s on the server.
  @tag :slow
  test "a generated report totals the user's own activity", %{conn: conn} do
    %{conn: conn, user: user} = register_and_log_in_user(%{conn: conn})
    order_fixture(user, product_fixture(price_cents: 500), 2)
    order_fixture(user_fixture(), product_fixture(price_cents: 9900), 4)
    message_fixture(user, room_fixture(), "Counted in the report")

    conn
    |> visit_live(~p"/reports")
    |> assert_has("#report-idle", text: "No report generated yet.")
    |> click_button("Generate report")
    |> assert_has("#report-running")
    |> assert_has("#report-result", timeout: 5_000)
    |> assert_has("#report-orders", text: "1", exact: true)
    |> assert_has("#report-units", text: "2", exact: true)
    |> assert_has("#report-total", text: "$10.00")
    |> assert_has("#report-messages", text: "1", exact: true)
  end

  test "a guest cannot open the reports page", %{conn: conn} do
    conn
    |> visit(~p"/reports")
    |> assert_path(~p"/users/log-in")
    |> assert_has("#flash-error", text: "You must log in to access this page.")
  end
end
