defmodule SampleApp.Orders.Order do
  use Ecto.Schema
  import Ecto.Changeset

  schema "orders" do
    field :quantity, :integer
    field :total_cents, :integer
    field :status, :string, default: "pending"

    belongs_to :user, SampleApp.Accounts.User
    belongs_to :product, SampleApp.Catalog.Product

    timestamps(type: :utc_datetime)
  end

  @doc false
  def changeset(order, attrs) do
    order
    |> cast(attrs, [:quantity])
    |> validate_required([:quantity])
    |> validate_number(:quantity, greater_than: 0)
  end
end
