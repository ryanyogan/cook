defmodule SampleAppWeb.ProductLive.Form do
  use SampleAppWeb, :live_view

  alias SampleApp.Catalog
  alias SampleApp.Catalog.Product

  @impl true
  def render(assigns) do
    ~H"""
    <Layouts.app flash={@flash} current_scope={@current_scope}>
      <.header>
        {@page_title}
        <:subtitle>Prices are entered in cents.</:subtitle>
      </.header>

      <.form for={@form} id="product-form" phx-change="validate" phx-submit="save" novalidate>
        <.input field={@form[:name]} type="text" label="Name" />
        <.input field={@form[:description]} type="textarea" label="Description" />
        <.input field={@form[:price_cents]} type="number" label="Price (cents)" />
        <.input field={@form[:stock]} type="number" label="Stock" />
        <footer class="flex gap-2">
          <.button variant="primary" id="save-product" phx-disable-with="Saving...">
            Save product
          </.button>
          <.button href={@return_to} id="cancel-product">Cancel</.button>
        </footer>
      </.form>
    </Layouts.app>
    """
  end

  @impl true
  def mount(params, _session, socket) do
    {:ok, apply_action(socket, socket.assigns.live_action, params)}
  end

  defp apply_action(socket, :new, _params) do
    product = %Product{}

    socket
    |> assign(:page_title, "New product")
    |> assign(:product, product)
    |> assign(:return_to, ~p"/products")
    |> assign(:form, to_form(Catalog.change_product(product)))
  end

  defp apply_action(socket, :edit, %{"id" => id}) do
    product = Catalog.get_product!(id)

    socket
    |> assign(:page_title, "Edit product")
    |> assign(:product, product)
    |> assign(:return_to, ~p"/products/#{product}")
    |> assign(:form, to_form(Catalog.change_product(product)))
  end

  @impl true
  def handle_event("validate", %{"product" => product_params}, socket) do
    changeset = Catalog.change_product(socket.assigns.product, product_params)
    {:noreply, assign(socket, :form, to_form(changeset, action: :validate))}
  end

  def handle_event("save", %{"product" => product_params}, socket) do
    save_product(socket, socket.assigns.live_action, product_params)
  end

  defp save_product(socket, :new, product_params) do
    case Catalog.create_product(socket.assigns.current_scope, product_params) do
      {:ok, product} ->
        {:noreply,
         socket
         |> put_flash(:info, "Product created.")
         |> redirect(to: ~p"/products/#{product}")}

      {:error, %Ecto.Changeset{} = changeset} ->
        {:noreply, assign(socket, :form, to_form(changeset))}
    end
  end

  defp save_product(socket, :edit, product_params) do
    %{current_scope: scope, product: product} = socket.assigns

    case Catalog.update_product(scope, product, product_params) do
      {:ok, product} ->
        {:noreply,
         socket
         |> put_flash(:info, "Product updated.")
         |> redirect(to: ~p"/products/#{product}")}

      {:error, %Ecto.Changeset{} = changeset} ->
        {:noreply, assign(socket, :form, to_form(changeset))}
    end
  end
end
