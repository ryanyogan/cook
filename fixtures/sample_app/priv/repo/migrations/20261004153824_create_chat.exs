defmodule SampleApp.Repo.Migrations.CreateChat do
  use Ecto.Migration

  def change do
    create table(:rooms) do
      add :slug, :string, null: false
      add :name, :string, null: false

      timestamps(type: :utc_datetime)
    end

    create unique_index(:rooms, [:slug])

    create table(:messages) do
      add :body, :text, null: false
      add :room_id, references(:rooms, on_delete: :delete_all), null: false
      add :user_id, references(:users, on_delete: :delete_all), null: false

      timestamps(type: :utc_datetime)
    end

    create index(:messages, [:room_id])
    create index(:messages, [:user_id])

    # The default room linked from the home page. It is created here, committed,
    # rather than on first visit: a get-or-create inside concurrent sandboxed
    # test transactions would block on the unique index.
    execute(
      "INSERT INTO rooms (slug, name, inserted_at, updated_at) VALUES ('lobby', 'Lobby', now(), now())",
      "DELETE FROM rooms WHERE slug = 'lobby'"
    )
  end
end
