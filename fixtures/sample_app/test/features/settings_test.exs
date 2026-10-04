defmodule SampleAppWeb.Features.SettingsTest do
  use SampleAppWeb.FeatureCase, async: true

  setup :register_and_log_in_user

  test "a user changes their password and signs in with the new one", %{conn: conn, user: user} do
    new_password = "a brand new password #{unique_tag()}"

    conn
    |> visit_live(~p"/users/settings")
    |> within("#password_form", fn conn ->
      conn
      |> fill_in("New password", with: new_password, exact: true)
      |> fill_in("Confirm new password", with: new_password)
      |> click_button("Save Password")
    end)
    |> assert_has("#flash-info", text: "Password updated successfully!")
    |> click_link("Log out")
    |> assert_has("#flash-info", text: "Logged out successfully.")
    |> log_in(user, new_password)
    |> assert_has("#auth-state", text: user.email)
  end

  test "a password confirmation that differs is rejected while typing", %{conn: conn} do
    conn
    |> visit_live(~p"/users/settings")
    |> within("#password_form", fn conn ->
      conn
      |> fill_in("New password", with: "a perfectly fine password", exact: true)
      |> fill_in("Confirm new password", with: "something else entirely")
    end)
    |> assert_has("#password_form", text: "does not match password")
  end
end
