defmodule SampleAppWeb.OrderLive.Index do
  use SampleAppWeb, :live_view

  alias Phoenix.LiveView.AsyncResult
  alias SampleApp.Money
  alias SampleApp.Orders

  # Deliberately SLOW: stands in for rendering a large export file.
  @simulated_work_ms 3_600

  @impl true
  def render(assigns) do
    ~H"""
    <Layouts.app flash={@flash} current_scope={@current_scope}>
      <.header>
        Your orders
        <:subtitle>Orders are confirmed in the background shortly after you place them.</:subtitle>
        <:actions>
          <.button id="export-orders" phx-click="export" disabled={@export && @export.loading}>
            Export order history
          </.button>
        </:actions>
      </.header>

      <div :if={@export} id="export-status">
        <p :if={@export.loading} id="export-running">Preparing your export...</p>
        <p :if={@export.ok?} id="export-result">
          Export ready: {@export.result.orders} orders, {@export.result.units} units, {Money.format(
            @export.result.total_cents
          )} in total.
        </p>
        <p :if={@export.failed} id="export-error" class="text-error">The export failed.</p>
      </div>

      <ul id="orders" phx-update="stream" class="divide-y divide-base-200">
        <li id="orders-empty" class="hidden only:block py-6 text-base-content/70">
          You have not ordered anything yet.
        </li>
        <li
          :for={{id, order} <- @streams.orders}
          id={id}
          class="flex items-center justify-between gap-4 py-3"
        >
          <span>
            <span data-role="quantity">{order.quantity}</span>
            &times;
            <.link href={~p"/products/#{order.product_id}"} class="font-semibold hover:underline">
              {order.product.name}
            </.link>
          </span>
          <span class="text-sm">
            <span data-role="total">{Money.format(order.total_cents)}</span>
            <span data-role="status" class="badge badge-sm ml-2">{order.status}</span>
          </span>
        </li>
      </ul>
    </Layouts.app>
    """
  end

  @impl true
  def mount(_params, _session, socket) do
    {:ok,
     socket
     |> assign(:page_title, "Your orders")
     |> assign(:export, nil)
     |> stream(:orders, Orders.list_orders(socket.assigns.current_scope))}
  end

  @impl true
  def handle_event("export", _params, socket) do
    scope = socket.assigns.current_scope

    {:noreply,
     socket
     |> assign(:export, AsyncResult.loading())
     |> start_async(:export, fn ->
       Process.sleep(@simulated_work_ms)
       Orders.order_totals(scope)
     end)}
  end

  @impl true
  def handle_async(:export, {:ok, totals}, socket) do
    {:noreply, assign(socket, :export, AsyncResult.ok(socket.assigns.export, totals))}
  end

  def handle_async(:export, {:exit, reason}, socket) do
    {:noreply, assign(socket, :export, AsyncResult.failed(socket.assigns.export, reason))}
  end
end
