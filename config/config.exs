# This file is responsible for configuring your application
# and its dependencies with the aid of the Config module.
#
# This configuration file is loaded before any dependency and
# is restricted to this project.

# General application configuration
import Config

config :cook,
  ecto_repos: [Cook.Repo],
  generators: [timestamp_type: :utc_datetime]

# The warm pool: one Playwright browser server plus one warm instance per target app.
# `test_timeout_ms` is the hard per-test cap. `max_cases` is how many scheduling units
# run at once; `shard` is how `async: true` modules are cut into units (`:packed`: as few
# shards per module as stay under the slowest test, `:test`: one per test, `:off`: whole
# modules). Measured 2026-10-04 on the sample app: 8 beat 16 and 44 (see .handoff/test-level-scheduling.md).
config :cook, Cook.Pool,
  enabled: true,
  browser_server: [host: "127.0.0.1", port: 4041],
  apps: [
    [path: Path.expand("../fixtures/sample_app", __DIR__), test_paths: ["test/features"]]
  ],
  test_timeout_ms: 10_000,
  max_cases: 8,
  shard: :packed,
  trace: false

# Runs: where failure artifacts go (absolute paths end up in the verdict) and
# how many runs' artifacts are kept.
config :cook, Cook.Runs,
  artifacts_dir: Path.expand("../artifacts", __DIR__),
  keep_artifact_runs: 20,
  ready_timeout_ms: 120_000

# Configure the endpoint
config :cook, CookWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [
    formats: [html: CookWeb.ErrorHTML, json: CookWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: Cook.PubSub,
  live_view: [signing_salt: "lZBl26EB"]

# Configure LiveView
config :phoenix_live_view,
  # the attribute set on all root tags. Used for Phoenix.LiveView.ColocatedCSS.
  root_tag_attribute: "phx-r"

# Configure esbuild (the version is required)
config :esbuild,
  version: "0.25.4",
  cook: [
    args:
      ~w(js/app.js --bundle --target=es2022 --outdir=../priv/static/assets/js --external:/fonts/* --external:/images/* --alias:@=.),
    cd: Path.expand("../assets", __DIR__),
    env: %{"NODE_PATH" => [Path.expand("../deps", __DIR__), Mix.Project.build_path()]}
  ]

# Configure tailwind (the version is required)
config :tailwind,
  version: "4.3.3",
  cook: [
    args: ~w(
      --input=assets/css/app.css
      --output=priv/static/assets/css/app.css
    ),
    cd: Path.expand("..", __DIR__),
    env: %{"NODE_PATH" => [Path.expand("../deps", __DIR__), Mix.Project.build_path()]}
  ]

# Configure Elixir's Logger
config :logger, :default_formatter,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id]

# Use Jason for JSON parsing in Phoenix
config :phoenix, :json_library, Jason

# Import environment specific config. This must remain at the bottom
# of this file so it overrides the configuration defined above.
import_config "#{config_env()}.exs"
