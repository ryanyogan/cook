defmodule SampleAppWeb.Features.SupportTest do
  use SampleAppWeb.FeatureCase, async: true

  test "a visitor files a ticket and gets a reference", %{conn: conn} do
    subject = "Parcel never arrived #{unique_tag()}"

    conn
    |> visit(~p"/support/new")
    |> fill_in("Your email", with: "shopper@example.com")
    |> fill_in("Subject", with: subject)
    |> fill_in("How can we help?", with: "It has been three weeks since I ordered.")
    |> click_button("Send ticket")
    |> assert_has("#flash-info", text: "Ticket submitted.")
    |> assert_has("h1", text: "Thanks, we got your ticket")
    |> assert_has("#ticket-reference", text: "T-")
    |> assert_has("#ticket-subject", text: subject)
    |> assert_has("#ticket-email", text: "shopper@example.com")
  end

  test "an empty ticket is rejected with a message per field", %{conn: conn} do
    conn
    |> visit(~p"/support/new")
    |> click_button("Send ticket")
    |> assert_has("#ticket-form p", text: "can't be blank", count: 3)
    |> assert_path(~p"/support")
  end

  test "a bad address and a too-short message keep what was typed", %{conn: conn} do
    subject = "Wrong colour #{unique_tag()}"

    conn
    |> visit(~p"/support/new")
    |> fill_in("Your email", with: "no at sign")
    |> fill_in("Subject", with: subject)
    |> fill_in("How can we help?", with: "Too short")
    |> click_button("Send ticket")
    |> assert_has("#ticket-form", text: "must have the @ sign and no spaces")
    |> assert_has("#ticket-form", text: "should be at least 10 character(s)")
    |> assert_has("#ticket_subject", value: subject)
  end
end
