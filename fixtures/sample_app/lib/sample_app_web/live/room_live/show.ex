defmodule SampleAppWeb.RoomLive.Show do
  use SampleAppWeb, :live_view

  alias SampleApp.Chat

  @impl true
  def render(assigns) do
    ~H"""
    <Layouts.app flash={@flash} current_scope={@current_scope}>
      <.header>
        <span id="room-name">{@room.name}</span>
        <:subtitle>Room /{@room.slug}</:subtitle>
        <:actions>
          <.button navigate={~p"/rooms"} id="all-rooms-link">All rooms</.button>
        </:actions>
      </.header>

      <ul id="messages" phx-update="stream" class="space-y-2">
        <li id="messages-empty" class="hidden only:block text-base-content/70">
          Nobody has said anything yet.
        </li>
        <li :for={{id, message} <- @streams.messages} id={id} class="rounded-box bg-base-200 p-3">
          <span data-role="author" class="text-xs text-base-content/70">{message.user.email}</span>
          <p data-role="body">{message.body}</p>
        </li>
      </ul>

      <%= if @current_scope do %>
        <.form for={@form} id="message-form" phx-submit="send" novalidate>
          <%!-- A fresh input id per sent message makes the browser drop the typed text. --%>
          <.input
            field={@form[:body]}
            id={"message-body-#{@sent_count}"}
            type="text"
            label="Message"
            autocomplete="off"
          />
          <.button variant="primary" id="send-message">Send</.button>
        </.form>
      <% else %>
        <p id="login-to-post">
          <.link href={~p"/users/log-in"} class="link">Sign in to post a message</.link>
        </p>
      <% end %>
    </Layouts.app>
    """
  end

  @impl true
  def mount(%{"slug" => slug}, _session, socket) do
    case Chat.get_room_by_slug(slug) do
      nil ->
        {:ok,
         socket
         |> put_flash(:error, "That room does not exist.")
         |> push_navigate(to: ~p"/rooms")}

      room ->
        if connected?(socket), do: Chat.subscribe(room)

        {:ok,
         socket
         |> assign(:page_title, room.name)
         |> assign(:room, room)
         |> assign(:sent_count, 0)
         |> assign_form(Chat.change_message())
         |> stream(:messages, Chat.list_messages(room))}
    end
  end

  @impl true
  def handle_event("send", %{"message" => message_params}, socket) do
    %{current_scope: scope, room: room} = socket.assigns

    if scope do
      # The sender's own copy also arrives through the room's PubSub topic.
      case Chat.create_message(scope, room, message_params) do
        {:ok, _message} ->
          {:noreply,
           socket |> update(:sent_count, &(&1 + 1)) |> assign_form(Chat.change_message())}

        {:error, %Ecto.Changeset{} = changeset} ->
          {:noreply, assign_form(socket, changeset)}
      end
    else
      {:noreply, redirect(socket, to: ~p"/users/log-in")}
    end
  end

  @impl true
  def handle_info({:new_message, message}, socket) do
    {:noreply, stream_insert(socket, :messages, message)}
  end

  defp assign_form(socket, %Ecto.Changeset{} = changeset) do
    assign(socket, :form, to_form(changeset))
  end
end
