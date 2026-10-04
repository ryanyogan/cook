defmodule SampleApp.Chat do
  @moduledoc """
  The Chat context: rooms, their messages, and live delivery over PubSub.

  Every room has its own topic, so a message only reaches viewers of that room.
  """

  import Ecto.Query, warn: false

  alias SampleApp.Accounts.Scope
  alias SampleApp.Accounts.User
  alias SampleApp.Chat.Message
  alias SampleApp.Chat.Room
  alias SampleApp.Repo

  @default_room_slug "lobby"
  @history_limit 50

  def default_room_slug, do: @default_room_slug

  def topic(%Room{slug: slug}), do: "room:#{slug}"

  @doc """
  Subscribes the caller to `{:new_message, message}` for the room.
  """
  def subscribe(%Room{} = room) do
    Phoenix.PubSub.subscribe(SampleApp.PubSub, topic(room))
  end

  def list_rooms(search \\ "") do
    search = String.trim(search || "")

    Room
    |> then(fn query ->
      if search == "",
        do: query,
        else: where(query, [r], ilike(r.name, ^"%#{search}%") or ilike(r.slug, ^"%#{search}%"))
    end)
    |> order_by([r], desc: r.id)
    |> limit(50)
    |> Repo.all()
  end

  def get_room_by_slug(slug) when is_binary(slug), do: Repo.get_by(Room, slug: slug)

  def create_room(%Scope{user: %User{}}, attrs) do
    %Room{}
    |> Room.changeset(attrs)
    |> Repo.insert()
  end

  def change_room(%Room{} = room \\ %Room{}, attrs \\ %{}) do
    Room.changeset(room, attrs)
  end

  @doc """
  The room's latest messages, oldest first, with their author preloaded.
  """
  def list_messages(%Room{id: room_id}) do
    Message
    |> where([m], m.room_id == ^room_id)
    |> order_by([m], desc: m.id)
    |> limit(@history_limit)
    |> preload(:user)
    |> Repo.all()
    |> Enum.reverse()
  end

  def count_messages(%Scope{user: %User{id: user_id}}) do
    Repo.aggregate(from(m in Message, where: m.user_id == ^user_id), :count)
  end

  def change_message(%Message{} = message \\ %Message{}, attrs \\ %{}) do
    Message.changeset(message, attrs)
  end

  @doc """
  Persists a message and broadcasts it to everyone viewing the room.
  """
  def create_message(%Scope{user: %User{} = user}, %Room{} = room, attrs) do
    changeset = Message.changeset(%Message{room_id: room.id, user_id: user.id}, attrs)

    with {:ok, message} <- Repo.insert(changeset) do
      message = %{message | user: user}
      Phoenix.PubSub.broadcast(SampleApp.PubSub, topic(room), {:new_message, message})
      {:ok, message}
    end
  end
end
