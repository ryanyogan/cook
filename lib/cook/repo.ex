defmodule Cook.Repo do
  use Ecto.Repo,
    otp_app: :cook,
    adapter: Ecto.Adapters.Postgres
end
