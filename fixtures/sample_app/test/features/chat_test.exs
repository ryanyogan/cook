defmodule SampleAppWeb.Features.ChatTest do
  use SampleAppWeb.FeatureCase, async: true

  test "a signed-in user posts a message to a room", %{conn: conn} do
    %{conn: conn, user: user} = register_and_log_in_user(%{conn: conn})
    room = room_fixture()
    text = "First post #{unique_tag()}"

    conn
    |> visit_live(~p"/rooms/#{room.slug}")
    |> assert_has("#messages-empty")
    |> fill_in("Message", with: text)
    |> click_button("Send")
    |> assert_has("#messages [data-role=body]", text: text)
    |> assert_has("#messages [data-role=author]", text: user.email)
    |> refute_has("#messages-empty")
  end

  test "an empty message is rejected", %{conn: conn} do
    %{conn: conn} = register_and_log_in_user(%{conn: conn})
    room = room_fixture()

    conn
    |> visit_live(~p"/rooms/#{room.slug}")
    |> click_button("Send")
    |> assert_has("#message-form", text: "can't be blank")
    |> assert_has("#messages-empty")
  end

  test "a guest can read a room but has to sign in to post", %{conn: conn} do
    room = room_fixture()
    text = "Read-only for guests #{unique_tag()}"
    message_fixture(user_fixture(), room, text)

    conn
    |> visit_live(~p"/rooms/#{room.slug}")
    |> assert_has("#messages [data-role=body]", text: text)
    |> assert_has("#login-to-post", text: "Sign in to post a message")
    |> refute_has("#message-form")
    |> click_link("Sign in to post a message")
    |> assert_path(~p"/users/log-in")
  end

  test "a room that does not exist sends the visitor to the room list", %{conn: conn} do
    conn
    |> visit(~p"/rooms/missing-#{unique_tag()}")
    |> assert_path(~p"/rooms")
    |> assert_has("#flash-error", text: "That room does not exist.")
  end
end
