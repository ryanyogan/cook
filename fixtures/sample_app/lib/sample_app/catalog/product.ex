defmodule SampleApp.Catalog.Product do
  use Ecto.Schema
  import Ecto.Changeset

  schema "products" do
    field :name, :string
    field :description, :string
    field :price_cents, :integer
    field :stock, :integer, default: 0

    timestamps(type: :utc_datetime)
  end

  @doc false
  def changeset(product, attrs) do
    product
    |> cast(attrs, [:name, :description, :price_cents, :stock])
    |> validate_required([:name, :price_cents, :stock])
    |> validate_length(:name, min: 2, max: 120)
    |> validate_number(:price_cents, greater_than: 0)
    |> validate_number(:stock, greater_than_or_equal_to: 0)
  end
end
