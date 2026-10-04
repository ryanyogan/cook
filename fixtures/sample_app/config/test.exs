import Config

# Only in tests, remove the complexity from the password hashing algorithm
config :bcrypt_elixir, :log_rounds, 1

# Configure your database
#
# The MIX_TEST_PARTITION environment variable can be used
# to provide built-in test partitioning in CI environment.
# Run `mix help test` for more information.
config :sample_app, SampleApp.Repo,
  username: "postgres",
  password: "postgres",
  hostname: "localhost",
  port: 5544,
  database: "sample_app_test#{System.get_env("MIX_TEST_PARTITION")}",
  pool: Ecto.Adapters.SQL.Sandbox,
  pool_size: System.schedulers_online() * 2

# Browser tests need a real server. The port comes from PORT in runtime.exs
# (default 4002 in test), so a warm runner can boot this app on its own port.
config :sample_app, SampleAppWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}],
  secret_key_base: "WYvspJq0K+7CcL1Q++Nt9K4c8yNjOf8cRrWILVpWnTOov7qKklBnZU1kQ9G/AMDl",
  server: true

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

# Share each test's sandboxed transaction with the requests and LiveViews it triggers
config :sample_app, :sql_sandbox, true

config :sample_app, SampleApp.Mailer, adapter: Swoosh.Adapters.Test
config :swoosh, :api_client, false

# Jobs run inline, inside the process (and so the sandbox) that enqueued them
config :sample_app, Oban, testing: :inline

# With PLAYWRIGHT_WS_ENDPOINT set, tests attach to an already-running Playwright
# server instead of spawning a Node driver and launching a browser themselves.
playwright_ws_endpoint = System.get_env("PLAYWRIGHT_WS_ENDPOINT")

config :phoenix_test,
  otp_app: :sample_app,
  playwright:
    [
      browser_context_opts: [
        viewport: %{width: 1280, height: 800},
        reduced_motion: "reduce",
        timezone_id: "UTC"
      ]
    ] ++
      if(playwright_ws_endpoint,
        do: [ws_endpoint: playwright_ws_endpoint, browser_pool: false],
        else: []
      )
