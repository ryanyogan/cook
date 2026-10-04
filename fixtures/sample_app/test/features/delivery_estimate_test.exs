defmodule SampleAppWeb.Features.DeliveryEstimateTest do
  use SampleAppWeb.FeatureCase, async: true

  # INTENTIONALLY FLAKY, do not "fix": the carrier lookup behind this button
  # answers after a random 1.0 to 2.25 s (SampleAppWeb.ProductLive.Show), and the
  # assertion only waits for the default 2 s. It fails roughly 3 runs in 10.
  @tag :flaky
  test "a delivery estimate appears after asking for one", %{conn: conn} do
    product = product_fixture()

    conn
    |> visit_live(~p"/products/#{product}")
    |> click_button("Estimate delivery")
    |> assert_has("#delivery-estimate", text: "Arrives in")
  end

  test "asking for an estimate says the carrier is being contacted", %{conn: conn} do
    product = product_fixture()

    conn
    |> visit_live(~p"/products/#{product}")
    |> refute_has("#delivery-estimate")
    |> click_button("Estimate delivery")
    |> assert_has("#delivery-estimate-loading", text: "Asking the carrier...")
  end
end
