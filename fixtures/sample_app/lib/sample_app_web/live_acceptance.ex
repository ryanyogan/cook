defmodule SampleAppWeb.LiveAcceptance do
  @moduledoc """
  Lets a LiveView join the Ecto sandbox of the browser test that opened it.

  The test's sandbox metadata arrives in the User-Agent header. Only mounted
  when `:sql_sandbox` is enabled (test env).
  """
  import Phoenix.LiveView
  import Phoenix.Component

  def on_mount(:default, _params, _session, socket) do
    socket =
      assign_new(socket, :phoenix_ecto_sandbox, fn ->
        if connected?(socket), do: get_connect_info(socket, :user_agent)
      end)

    Phoenix.Ecto.SQL.Sandbox.allow(socket.assigns.phoenix_ecto_sandbox, Ecto.Adapters.SQL.Sandbox)
    {:cont, socket}
  end
end
