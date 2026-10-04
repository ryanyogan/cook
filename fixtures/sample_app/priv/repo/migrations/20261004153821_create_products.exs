defmodule SampleApp.Repo.Migrations.CreateProducts do
  use Ecto.Migration

  def change do
    create table(:products) do
      add :name, :string, null: false
      add :description, :text
      add :price_cents, :integer, null: false
      add :stock, :integer, null: false, default: 0

      timestamps(type: :utc_datetime)
    end

    create index(:products, [:name])
  end
end
