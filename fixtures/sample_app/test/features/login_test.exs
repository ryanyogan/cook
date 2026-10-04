defmodule SampleAppWeb.Features.LoginTest do
  use SampleAppWeb.FeatureCase, async: true

  test "a user signs in with their password", %{conn: conn} do
    user = user_fixture() |> set_password()

    conn
    |> log_in(user)
    |> assert_has("a", text: "Log out")
  end

  test "a wrong password is rejected", %{conn: conn} do
    user = user_fixture() |> set_password()

    conn
    |> visit_live(~p"/users/log-in")
    |> submit_password_login(user.email, "not the password")
    |> assert_has("#flash-error", text: "Invalid email or password")
  end

  test "a signed-in user logs out", %{conn: conn} do
    user = user_fixture() |> set_password()

    conn
    |> log_in(user)
    |> click_link("Log out")
    |> assert_has("#flash-info", text: "Logged out successfully.")
    |> assert_has("#auth-state", text: "You are browsing as a guest.")
  end

  test "a guest opening an authenticated page is sent to the login page", %{conn: conn} do
    conn
    |> visit(~p"/orders")
    |> assert_path(~p"/users/log-in")
    |> assert_has("#flash-error", text: "You must log in to access this page.")
  end

  test "after signing in, the guest lands on the page they first asked for", %{conn: conn} do
    user = user_fixture() |> set_password()

    conn
    |> visit(~p"/orders")
    |> assert_path(~p"/users/log-in")
    |> wait_for_live()
    |> submit_password_login(user.email, valid_user_password())
    |> assert_path(~p"/orders")
    |> assert_has("h1", text: "Your orders")
  end
end
