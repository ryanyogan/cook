defmodule SampleAppWeb.Features.HomeTest do
  use SampleAppWeb.FeatureCase, async: true

  test "a guest sees the landing page with ways to sign in", %{conn: conn} do
    conn
    |> visit(~p"/")
    |> assert_has("h1", text: "Welcome to Sample Shop")
    |> assert_has("#auth-state", text: "You are browsing as a guest.")
    |> assert_has("a", text: "Register")
    |> assert_has("a", text: "Log in")
    |> refute_has("#main-nav a", text: "Orders")
  end

  test "a signed-in user sees who they are and their account links", %{conn: conn} do
    %{conn: conn, user: user} = register_and_log_in_user(%{conn: conn})

    conn
    |> visit(~p"/")
    |> assert_has("#auth-state", text: "Signed in as #{user.email}")
    |> assert_has("#main-nav a", text: "Orders")
    |> assert_has("#main-nav a", text: "Reports")
    |> assert_has("a", text: "Log out")
  end

  test "the landing page links to products, the lobby and support", %{conn: conn} do
    conn
    |> visit(~p"/")
    |> click_link("Browse products")
    |> assert_path(~p"/products")
    |> assert_has("h1", text: "Products")
    |> visit(~p"/")
    |> click_link("Join the lobby")
    |> assert_path(~p"/rooms/lobby")
    |> assert_has("#room-name", text: "Lobby")
    |> visit(~p"/")
    |> click_link("Contact support")
    |> assert_path(~p"/support/new")
    |> assert_has("h1", text: "Contact support")
  end
end
