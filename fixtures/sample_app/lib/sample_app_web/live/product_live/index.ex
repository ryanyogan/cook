defmodule SampleAppWeb.ProductLive.Index do
  use SampleAppWeb, :live_view

  alias SampleApp.Catalog
  alias SampleApp.Money

  @impl true
  def render(assigns) do
    ~H"""
    <Layouts.app flash={@flash} current_scope={@current_scope}>
      <.header>
        Products
        <:subtitle>Everything currently in the catalog.</:subtitle>
        <:actions :if={@current_scope}>
          <.button href={~p"/products/import"} id="import-products-link">Bulk import</.button>
          <.button variant="primary" href={~p"/products/new"} id="new-product-link">
            New product
          </.button>
        </:actions>
      </.header>

      <.form for={@search_form} id="product-search" phx-change="search" phx-submit="search">
        <.input
          field={@search_form[:q]}
          type="search"
          label="Search products"
          placeholder="Type a product name"
          autocomplete="off"
          phx-debounce="100"
        />
      </.form>

      <ul id="products" phx-update="stream" class="divide-y divide-base-200">
        <li id="products-empty" class="hidden only:block py-6 text-base-content/70">
          No products match your search.
        </li>
        <li
          :for={{id, product} <- @streams.products}
          id={id}
          class="flex items-center justify-between gap-4 py-3"
        >
          <.link navigate={~p"/products/#{product}"} class="font-semibold hover:underline">
            {product.name}
          </.link>
          <span class="text-sm text-base-content/70">
            {Money.format(product.price_cents)} &middot;
            <span :if={product.stock > 0}>{product.stock} in stock</span>
            <span :if={product.stock == 0} class="text-error">Out of stock</span>
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
     |> assign(:page_title, "Products")
     |> assign(:search_form, to_form(%{"q" => ""}))
     |> stream(:products, Catalog.list_products())}
  end

  @impl true
  def handle_event("search", %{"q" => q}, socket) do
    {:noreply,
     socket
     |> assign(:search_form, to_form(%{"q" => q}))
     |> stream(:products, Catalog.list_products(q), reset: true)}
  end
end
