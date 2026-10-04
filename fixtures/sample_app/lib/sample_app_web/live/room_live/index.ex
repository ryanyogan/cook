defmodule SampleAppWeb.RoomLive.Index do
  use SampleAppWeb, :live_view

  alias SampleApp.Chat

  @impl true
  def render(assigns) do
    ~H"""
    <Layouts.app flash={@flash} current_scope={@current_scope}>
      <.header>
        Chat rooms
        <:subtitle>Pick a room, or open a new one.</:subtitle>
      </.header>

      <.form
        :if={@current_scope}
        for={@form}
        id="room-form"
        phx-change="validate"
        phx-submit="save"
        novalidate
      >
        <.input field={@form[:name]} type="text" label="Room name" />
        <.input field={@form[:slug]} type="text" label="Slug" />
        <.button variant="primary" id="create-room" phx-disable-with="Opening...">
          Open room
        </.button>
      </.form>
      <p :if={!@current_scope} id="login-to-create-room">
        <.link href={~p"/users/log-in"} class="link">Sign in to open a room</.link>
      </p>

      <ul id="rooms" phx-update="stream" class="divide-y divide-base-200">
        <li :for={{id, room} <- @streams.rooms} id={id} class="py-3">
          <.link navigate={~p"/rooms/#{room.slug}"} class="font-semibold hover:underline">
            {room.name}
          </.link>
          <span class="text-sm text-base-content/70">/{room.slug}</span>
        </li>
      </ul>
    </Layouts.app>
    """
  end

  @impl true
  def mount(_params, _session, socket) do
    {:ok,
     socket
     |> assign(:page_title, "Chat rooms")
     |> assign(:form, to_form(Chat.change_room()))
     |> stream(:rooms, Chat.list_rooms())}
  end

  @impl true
  def handle_event("validate", %{"room" => room_params}, socket) do
    changeset = Chat.change_room(%Chat.Room{}, room_params)
    {:noreply, assign(socket, :form, to_form(changeset, action: :validate))}
  end

  def handle_event("save", %{"room" => room_params}, socket) do
    scope = socket.assigns.current_scope

    if scope do
      case Chat.create_room(scope, room_params) do
        {:ok, room} ->
          {:noreply,
           socket
           |> put_flash(:info, "Room opened.")
           |> push_navigate(to: ~p"/rooms/#{room.slug}")}

        {:error, %Ecto.Changeset{} = changeset} ->
          {:noreply, assign(socket, :form, to_form(changeset))}
      end
    else
      {:noreply, redirect(socket, to: ~p"/users/log-in")}
    end
  end
end
