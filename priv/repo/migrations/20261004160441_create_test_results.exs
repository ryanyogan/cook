defmodule Cook.Repo.Migrations.CreateTestResults do
  use Ecto.Migration

  def change do
    create table(:test_results) do
      add :run_id, references(:runs, on_delete: :delete_all), null: false
      add :path, :text, null: false
      add :test_id, :text, null: false
      add :file, :text, null: false
      add :line, :integer
      add :module, :text, null: false
      add :name, :text, null: false
      add :status, :string, null: false
      add :duration_ms, :integer, null: false, default: 0
      add :started_ms, :integer

      timestamps(type: :utc_datetime_usec, updated_at: false)
    end

    create index(:test_results, [:run_id])
    create index(:test_results, [:path, :module, :name, :id])
  end
end
