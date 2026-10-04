defmodule Cook.Runs.Run do
  @moduledoc """
  One `cook run`: its outcome, timings and the verdict that was returned.
  """

  use Ecto.Schema

  schema "runs" do
    field :public_id, :string
    field :path, :string
    field :status, :string
    field :selection_reason, :string
    field :selected, :integer, default: 0
    field :skipped, :integer, default: 0
    field :passed, :integer, default: 0
    field :failed, :integer, default: 0
    field :duration_ms, :integer
    field :overhead_ms, :integer
    field :tests_ms, :integer
    field :slowest_test_ms, :integer
    field :first_test_ms, :integer
    field :error, :string
    field :verdict, :map

    has_many :test_results, Cook.Runs.TestResult

    timestamps(type: :utc_datetime_usec, updated_at: false)
  end
end
