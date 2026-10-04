defmodule SampleApp.ChatFixtures do
  @moduledoc """
  Test helpers for creating entities via the `SampleApp.Chat` context.
  """

  alias SampleApp.Accounts.Scope
  alias SampleApp.AccountsFixtures
  alias SampleApp.Chat

  def unique_room_slug, do: "room-#{System.unique_integer([:positive])}"

  def room_fixture(attrs \\ %{}) do
    slug = unique_room_slug()
    attrs = Enum.into(attrs, %{slug: slug, name: "Room #{slug}"})

    {:ok, room} = Chat.create_room(AccountsFixtures.user_scope_fixture(), attrs)
    room
  end

  def message_fixture(user, room, body) do
    {:ok, message} = Chat.create_message(Scope.for_user(user), room, %{body: body})
    message
  end
end
