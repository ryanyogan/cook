defmodule SampleAppWeb.SupportController do
  use SampleAppWeb, :controller

  alias SampleApp.Support

  def new(conn, _params) do
    render(conn, :new, form: Phoenix.Component.to_form(Support.change_ticket()))
  end

  def create(conn, %{"ticket" => ticket_params}) do
    case Support.create_ticket(ticket_params) do
      {:ok, ticket} ->
        conn
        |> put_flash(:info, "Ticket submitted.")
        |> redirect(to: ~p"/support/tickets/#{ticket.reference}")

      {:error, %Ecto.Changeset{} = changeset} ->
        conn
        |> put_status(:unprocessable_entity)
        |> render(:new, form: Phoenix.Component.to_form(changeset))
    end
  end

  def show(conn, %{"reference" => reference}) do
    case Support.get_ticket_by_reference(reference) do
      nil ->
        conn
        |> put_flash(:error, "Ticket not found.")
        |> redirect(to: ~p"/support/new")

      ticket ->
        render(conn, :show, ticket: ticket)
    end
  end
end
