defmodule SampleApp.Support do
  @moduledoc """
  The Support context: tickets anyone can file, logged in or not.
  """

  alias SampleApp.Repo
  alias SampleApp.Support.Ticket

  def change_ticket(%Ticket{} = ticket \\ %Ticket{}, attrs \\ %{}) do
    Ticket.changeset(ticket, attrs)
  end

  @doc """
  Creates a ticket under a random reference the submitter can quote later.
  """
  def create_ticket(attrs) do
    %Ticket{reference: generate_reference()}
    |> Ticket.changeset(attrs)
    |> Repo.insert()
  end

  def get_ticket_by_reference(reference) when is_binary(reference) do
    Repo.get_by(Ticket, reference: reference)
  end

  defp generate_reference do
    "T-" <> (5 |> :crypto.strong_rand_bytes() |> Base.encode32(padding: false))
  end
end
