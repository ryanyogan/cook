defmodule Cook.Repo.Migrations.CreateRuns do
  use Ecto.Migration

  def change do
    create table(:runs) do
      add :public_id, :string, null: false
      add :path, :text, null: false
      add :status, :string, null: false
      add :selection_reason, :string
      add :selected, :integer, null: false, default: 0
      add :skipped, :integer, null: false, default: 0
      add :passed, :integer, null: false, default: 0
      add :failed, :integer, null: false, default: 0
      add :duration_ms, :integer
      add :overhead_ms, :integer
      add :tests_ms, :integer
      add :slowest_test_ms, :integer
      add :first_test_ms, :integer
      add :error, :text
      add :verdict, :map, null: false

      timestamps(type: :utc_datetime_usec, updated_at: false)
    end

    create unique_index(:runs, [:public_id])
    create index(:runs, [:path, :id])
  end
end
