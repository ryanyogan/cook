defmodule SampleAppWeb.Features.ChatBroadcastTest do
  use SampleAppWeb.FeatureCase, async: true

  test "a message appears live for another browser in the same room",
       %{conn: conn} = context do
    room = room_fixture()
    text = "Live hello #{unique_tag()}"

    %{conn: poster, user: user} = register_and_log_in_user(%{conn: conn})
    viewer = context |> new_browser_session() |> visit_live(~p"/rooms/#{room.slug}")

    poster
    |> visit_live(~p"/rooms/#{room.slug}")
    |> fill_in("Message", with: text)
    |> click_button("Send")
    |> assert_has("#messages [data-role=body]", text: text)

    viewer
    |> assert_has("#messages [data-role=body]", text: text)
    |> assert_has("#messages [data-role=author]", text: user.email)
  end

  test "a message stays inside the room it was posted in", %{conn: conn} = context do
    room = room_fixture()
    other_room = room_fixture()
    text = "Only for this room #{unique_tag()}"
    marker = "Other room marker #{unique_tag()}"

    %{conn: poster, user: user} = register_and_log_in_user(%{conn: conn})
    bystander = context |> new_browser_session() |> visit_live(~p"/rooms/#{other_room.slug}")

    poster
    |> visit_live(~p"/rooms/#{room.slug}")
    |> fill_in("Message", with: text)
    |> click_button("Send")
    |> assert_has("#messages [data-role=body]", text: text)

    # Broadcast to the bystander's room afterwards. Once that later message has
    # arrived, the earlier one would have too if it had leaked.
    message_fixture(user, other_room, marker)

    bystander
    |> assert_has("#messages [data-role=body]", text: marker)
    |> refute_has("#messages [data-role=body]", text: text)
  end

  test "a room shows its earlier messages to someone who joins later", %{conn: conn} do
    room = room_fixture()
    author = user_fixture()
    first = "Earlier one #{unique_tag()}"
    second = "Earlier two #{unique_tag()}"
    message_fixture(author, room, first)
    message_fixture(author, room, second)

    conn
    |> visit_live(~p"/rooms/#{room.slug}")
    |> assert_has("#messages [data-role=body]", text: first)
    |> assert_has("#messages [data-role=body]", text: second)
    |> assert_has("#messages [data-role=author]", text: author.email, count: 2)
  end
end
