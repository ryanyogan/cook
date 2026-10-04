import Config

# Configure your database
#
# The MIX_TEST_PARTITION environment variable can be used
# to provide built-in test partitioning in CI environment.
# Run `mix help test` for more information.
config :cook, Cook.Repo,
  username: "postgres",
  password: "postgres",
  hostname: "localhost",
  port: 5544,
  database: "cook_test#{System.get_env("MIX_TEST_PARTITION")}",
  pool: Ecto.Adapters.SQL.Sandbox,
  pool_size: System.schedulers_online() * 2

# We don't run a server during test. If one is required,
# you can enable the server option below.
config :cook, CookWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "k8U/273LyCr3Uyc0T1a0TPynZ65jRW89x0ceImbjMS9vhKdE3YyNfqL4RmwuLc5H",
  server: false

# Print only warnings and errors during test
config :logger, level: :warning

# Initialize plugs at runtime for faster test compilation
config :phoenix, :plug_init_mode, :runtime

# Enable helpful, but potentially expensive runtime checks
config :phoenix_live_view,
  enable_expensive_runtime_checks: true

# Sort query params output of verified routes for robust url comparisons
config :phoenix,
  sort_verified_routes_query_params: true

# Cook's own tests never launch browsers or boot a target app
config :cook, Cook.Pool, enabled: false

# Runs go to a stub pool and leave no artifacts.
config :cook, Cook.Runs, pool: Cook.PoolStub, artifacts_dir: nil, ready_timeout_ms: 200
