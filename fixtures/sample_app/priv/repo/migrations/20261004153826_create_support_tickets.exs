defmodule SampleApp.Repo.Migrations.CreateSupportTickets do
  use Ecto.Migration

  def change do
    create table(:support_tickets) do
      add :reference, :string, null: false
      add :subject, :string, null: false
      add :body, :text, null: false
      add :email, :string, null: false

      timestamps(type: :utc_datetime)
    end

    create unique_index(:support_tickets, [:reference])
  end
end
