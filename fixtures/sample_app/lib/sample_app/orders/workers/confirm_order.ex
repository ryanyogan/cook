defmodule SampleApp.Orders.Workers.ConfirmOrder do
  @moduledoc """
  Marks a freshly placed order as confirmed.
  """
  use Oban.Worker, queue: :default, max_attempts: 3

  alias SampleApp.Orders

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"order_id" => order_id}}) do
    Orders.confirm_order(order_id)
    :ok
  end
end
