defmodule SampleAppWeb.ProductLive.Import do
  use SampleAppWeb, :live_view

  alias Phoenix.LiveView.AsyncResult
  alias SampleApp.Catalog

  # Deliberately SLOW: stands in for parsing and validating a large upload.
  @simulated_work_ms 1_750

  @impl true
  def render(assigns) do
    ~H"""
    <Layouts.app flash={@flash} current_scope={@current_scope}>
      <.header>
        Bulk import
        <:subtitle>One product per line: <code>name,price in cents,stock</code></:subtitle>
      </.header>

      <.form for={@form} id="import-form" phx-submit="import" novalidate>
        <.input field={@form[:rows]} type="textarea" label="Product rows" rows="6" />
        <.button
          variant="primary"
          id="start-import"
          disabled={@import && @import.loading}
          phx-disable-with="Importing..."
        >
          Import products
        </.button>
      </.form>

      <div :if={@import} id="import-status">
        <p :if={@import.loading} id="import-running">Importing, this takes a moment...</p>
        <p :if={@import.ok?} id="import-result">Imported {@import.result} products.</p>
        <p :if={@import.failed} id="import-error" class="text-error">{@import.failed}</p>
      </div>

      <p>
        <.link href={~p"/products"} id="back-to-products" class="link">Back to products</.link>
      </p>
    </Layouts.app>
    """
  end

  @impl true
  def mount(_params, _session, socket) do
    {:ok,
     socket
     |> assign(:page_title, "Bulk import")
     |> assign(:import, nil)
     |> assign(:form, to_form(%{"rows" => ""}, as: :import))}
  end

  @impl true
  def handle_event("import", %{"import" => %{"rows" => rows}}, socket) do
    scope = socket.assigns.current_scope
    socket = assign(socket, :form, to_form(%{"rows" => rows}, as: :import))

    if String.trim(rows) == "" do
      {:noreply, assign(socket, :import, AsyncResult.failed(%AsyncResult{}, "Nothing to import"))}
    else
      {:noreply,
       socket
       |> assign(:import, AsyncResult.loading())
       |> start_async(:import, fn ->
         Process.sleep(@simulated_work_ms)
         Catalog.import_products(scope, rows)
       end)}
    end
  end

  @impl true
  def handle_async(:import, {:ok, {:ok, count}}, socket) do
    {:noreply, assign(socket, :import, AsyncResult.ok(socket.assigns.import, count))}
  end

  def handle_async(:import, {:ok, {:error, message}}, socket) do
    {:noreply, assign(socket, :import, AsyncResult.failed(socket.assigns.import, message))}
  end

  def handle_async(:import, {:exit, _reason}, socket) do
    {:noreply,
     assign(socket, :import, AsyncResult.failed(socket.assigns.import, "The import crashed."))}
  end
end
