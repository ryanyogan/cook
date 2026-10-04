defmodule SampleApp.Reports do
  @moduledoc """
  Activity summaries for a single user.
  """

  alias SampleApp.Accounts.Scope
  alias SampleApp.Chat
  alias SampleApp.Orders

  @doc """
  Totals of everything the scope user has ordered and posted.
  """
  def activity_report(%Scope{} = scope) do
    scope
    |> Orders.order_totals()
    |> Map.put(:messages, Chat.count_messages(scope))
  end
end
