defmodule Cook.Runs.TestResult do
  @moduledoc """
  The result of one test in one run. Kept for every test of every run: durations
  drive longest-first ordering and the history feeds the flake ledger later.

  `status` is the verdict's view (`"passed" | "failed" | "skipped" | "invalid"`):
  a test over the per-test cap is `"failed"` here even if ExUnit let it pass.
  `started_ms` is when the test started, in ms after the run's first test.
  """

  use Ecto.Schema

  schema "test_results" do
    field :path, :string
    field :test_id, :string
    field :file, :string
    field :line, :integer
    field :module, :string
    field :name, :string
    field :status, :string
    field :duration_ms, :integer, default: 0
    field :started_ms, :integer

    belongs_to :run, Cook.Runs.Run

    timestamps(type: :utc_datetime_usec, updated_at: false)
  end
end
