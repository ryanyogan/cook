defmodule SampleApp.Support.Ticket do
  use Ecto.Schema
  import Ecto.Changeset

  schema "support_tickets" do
    field :reference, :string
    field :subject, :string
    field :body, :string
    field :email, :string

    timestamps(type: :utc_datetime)
  end

  @doc false
  def changeset(ticket, attrs) do
    ticket
    |> cast(attrs, [:subject, :body, :email])
    |> validate_required([:subject, :body, :email])
    |> validate_length(:subject, min: 3, max: 120)
    |> validate_length(:body, min: 10, max: 2000)
    |> validate_format(:email, ~r/^[^@,;\s]+@[^@,;\s]+$/,
      message: "must have the @ sign and no spaces"
    )
  end
end
