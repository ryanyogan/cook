defmodule SampleAppWeb.ProductLive.Show do
  use SampleAppWeb, :live_view

  alias SampleApp.Catalog
  alias SampleApp.Money
  alias SampleApp.Orders

  # The carrier lookup is simulated. Its latency is random and its upper end
  # is slower than a browser test's default 2 s assertion timeout: this is the
  # fixture's one deliberately FLAKY path (see test/features/delivery_estimate_test.exs).
  @estimate_delay_ms 1_000..2_250

  @impl true
  def render(assigns) do
    ~H"""
    <Layouts.app flash={@flash} current_scope={@current_scope}>
      <.header>
        <span id="product-name">{@product.name}</span>
        <:subtitle>
          <span id="product-price">{Money.format(@product.price_cents)}</span>
          &middot;
          <span id="product-stock">
            {if @product.stock > 0, do: "#{@product.stock} in stock", else: "Out of stock"}
          </span>
        </:subtitle>
        <:actions :if={@current_scope}>
          <.button href={~p"/products/#{@product}/edit"} id="edit-product-link">Edit</.button>
          <.button
            id="delete-product"
            phx-click="delete"
            data-confirm="Delete this product for good?"
          >
            Delete
          </.button>
        </:actions>
      </.header>

      <p id="product-description">{@product.description}</p>

      <section id="delivery" class="rounded-box border border-base-300 p-4 space-y-2">
        <.button id="estimate-delivery" phx-click="estimate_delivery">Estimate delivery</.button>
        <p :if={@estimate == :loading} id="delivery-estimate-loading">Asking the carrier...</p>
        <p :if={is_integer(@estimate)} id="delivery-estimate">
          Arrives in {@estimate} days
        </p>
      </section>

      <section id="ordering" class="rounded-box border border-base-300 p-4">
        <%= if @current_scope do %>
          <.form for={@order_form} id="order-form" phx-submit="order" novalidate>
            <.input field={@order_form[:quantity]} type="number" label="Quantity" />
            <.button variant="primary" id="place-order" phx-disable-with="Ordering...">
              Place order
            </.button>
          </.form>
          <p :if={@last_order} id="order-confirmation" class="mt-3">
            Order #{@last_order.id} placed: {@last_order.quantity} for {Money.format(
              @last_order.total_cents
            )}. <.link href={~p"/orders"} id="view-orders-link" class="link">View your orders</.link>
          </p>
        <% else %>
          <p id="login-to-order">
            <.link href={~p"/users/log-in"} class="link">Sign in to order</.link>
          </p>
        <% end %>
      </section>

      <p>
        <.link navigate={~p"/products"} id="back-to-products" class="link">Back to products</.link>
      </p>
    </Layouts.app>
    """
  end

  @impl true
  def mount(%{"id" => id}, _session, socket) do
    product = Catalog.get_product!(id)

    {:ok,
     socket
     |> assign(:page_title, product.name)
     |> assign(:product, product)
     |> assign(:estimate, nil)
     |> assign(:last_order, nil)
     |> assign_order_form(Orders.change_order(%Orders.Order{}, %{quantity: 1}))}
  end

  @impl true
  def handle_event("estimate_delivery", _params, socket) do
    delay = Enum.random(@estimate_delay_ms)

    {:noreply,
     socket
     |> assign(:estimate, :loading)
     |> start_async(:estimate, fn ->
       Process.sleep(delay)
       Enum.random(2..5)
     end)}
  end

  def handle_event("order", %{"order" => order_params}, socket) do
    %{current_scope: scope, product: product} = socket.assigns

    if scope do
      case Orders.create_order(scope, product, order_params) do
        {:ok, order} ->
          {:noreply,
           socket
           |> assign(:product, Catalog.get_product!(product.id))
           |> assign(:last_order, order)
           |> assign_order_form(Orders.change_order(%Orders.Order{}, %{quantity: 1}))
           |> put_flash(:info, "Order placed.")}

        {:error, %Ecto.Changeset{} = changeset} ->
          {:noreply,
           socket
           |> assign(:product, Catalog.get_product!(product.id))
           |> assign_order_form(changeset)}
      end
    else
      {:noreply, redirect(socket, to: ~p"/users/log-in")}
    end
  end

  def handle_event("delete", _params, socket) do
    %{current_scope: scope, product: product} = socket.assigns

    if scope do
      {:ok, _product} = Catalog.delete_product(scope, product)

      {:noreply,
       socket
       |> put_flash(:info, "Product deleted.")
       |> push_navigate(to: ~p"/products")}
    else
      {:noreply, redirect(socket, to: ~p"/users/log-in")}
    end
  end

  @impl true
  def handle_async(:estimate, {:ok, days}, socket) do
    {:noreply, assign(socket, :estimate, days)}
  end

  def handle_async(:estimate, {:exit, _reason}, socket) do
    {:noreply, assign(socket, :estimate, nil)}
  end

  defp assign_order_form(socket, %Ecto.Changeset{} = changeset) do
    assign(socket, :order_form, to_form(changeset))
  end
end
