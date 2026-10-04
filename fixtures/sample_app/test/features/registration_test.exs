defmodule SampleAppWeb.Features.RegistrationTest do
  use SampleAppWeb.FeatureCase, async: true

  test "registering sends login instructions to the new address", %{conn: conn} do
    email = unique_user_email()

    conn
    |> register(email)
    |> assert_has("#flash-info", text: "An email was sent to #{email}")
    |> assert_path(~p"/users/log-in")
  end

  test "an address without an @ sign is rejected while typing", %{conn: conn} do
    conn
    |> visit_live(~p"/users/register")
    |> fill_in("Email", with: "not-an-address")
    |> assert_has("#registration_form", text: "must have the @ sign and no spaces")
  end

  test "a new user confirms their account through the emailed link", %{conn: conn} do
    email = unique_user_email()

    conn
    |> register(email)
    |> assert_has("#flash-info", text: "An email was sent to #{email}")

    # The mail goes to the server's mailbox, so mint the link it would contain.
    user = SampleApp.Accounts.get_user_by_email(email)
    {token, _hashed_token} = generate_user_magic_link_token(user)

    conn
    |> visit_live(~p"/users/log-in/#{token}")
    |> click_button("Confirm and stay logged in")
    |> assert_has("#flash-info", text: "User confirmed successfully.")
    |> assert_has("#auth-state", text: email)
  end

  defp register(conn, email) do
    conn
    |> visit_live(~p"/users/register")
    |> fill_in("Email", with: email)
    |> click_button("Create an account")
  end
end
