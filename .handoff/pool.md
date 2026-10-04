# Stage 1: pool

## Status
COMPLETE (2026-10-04)

## Done
- `priv/playwright/package.json` + `package-lock.json`: playwright 1.63.0. `node_modules` is git-ignored
  (`.gitignore`). Install: `cd priv/playwright && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install`
  (Chromium rev 1243 is already in `~/.cache/ms-playwright`; elsewhere run `npx playwright install chromium`).
- `priv/pool/port_wrapper.sh`: runs a program in its own process group and kills the group when the
  Port's stdin closes (owner died, or the Cook VM went away).
- `lib/cook/pool/os_process.ex`: opens Ports through the wrapper.
- `lib/cook/pool/distribution.ex`: starts epmd + short-name distribution (`cook_<os pid>@host`, random cookie)
  unless the VM is already a node.
- `lib/cook/pool/browser_server.ex`: Playwright `run-server` on 127.0.0.1:4041. `init/1` blocks until the
  port accepts TCP. OS exit => GenServer stops => supervisor restarts it and the instances.
- `lib/cook/pool/app_instance.ex`: one per app path. Boots
  `elixir --sname cook_app_<hash>_<unique> --cookie … --hidden -S mix do ecto.create --quiet + ecto.migrate --quiet + run --no-halt -e 'IO.puts("COOK_INSTANCE_READY")'`
  with `MIX_ENV=test PORT=<free> PHX_SERVER=true PLAYWRIGHT_WS_ENDPOINT=ws://127.0.0.1:4041`, waits for the
  marker, connects, injects `Cook.Agent` + `Cook.Agent.Formatter`, calls `Cook.Agent.boot/1`. On OS exit,
  node down, test-helper process death or boot failure it reboots the instance itself with backoff
  (1 s doubling to 10 s); the GenServer stays up.
- `lib/cook/agent.ex`, `lib/cook/agent/formatter.ex`: run inside the instance (Elixir/OTP/ExUnit/Mix only).
- `lib/cook/pool/supervisor.ex`: `rest_for_one` [Registry, BrowserServer, `Cook.Pool.Instances` (one_for_one)].
- `lib/cook/pool.ex`: public API. `lib/cook/application.ex` starts the pool only when enabled.
- Config: `config/config.exs` (`config :cook, Cook.Pool, enabled: true, browser_server: [host:, port: 4041],
  apps: [[path: <abs fixtures/sample_app>, test_paths: ["test/features"]]], test_timeout_ms: 10_000, max_cases: 8`),
  `config/test.exs` (`enabled: false`), `config/runtime.exs` (`COOK_POOL=0` disables it for one-off tasks).
- Unit tests: `test/cook/agent_test.exs`, `test/cook/agent/formatter_test.exs`, `test/cook/pool_test.exs`,
  `test/cook/pool/commands_test.exs`. No browsers, no app boot.

## Verified
All on this machine, 2026-10-04, with the other agent editing and running `fixtures/sample_app` at the same time.
- `mix compile --warnings-as-errors`: clean. `mix precommit`: 43 tests pass, 0.1 s ExUnit, 0.6 s wall.
- Real sample app, one daemon lifetime (`mix run <driver script>`), pool boot then:
  - Instance ready 756 ms after start (14 test files loaded in 103 ms). First call incl. boot wait: 1986 ms.
  - 5 consecutive warm runs of `test/features/login_test.exs` (5 tests, all passed):
    request -> first test started 27 / 52 / 47 / 46 / 52 ms; total 1130 / 1250 / 1165 / 1227 / 1166 ms.
  - 3 warm runs of all of `test/features` (44 tests, max_cases 8): first test 42 / 54 / 107 ms;
    total 5535 / 5685 / 6261 ms; 43+1 failed, 44 passed, 44 passed (the one failure:
    `delivery_estimate_test.exs:8`, "Could not find element #delivery-estimate").
  - Overhead (total - ExUnit run) was 26-106 ms, almost all of it the in-VM `mix compile` no-op check.
  - Cold comparison, same machine, everything already compiled: `mix test test/features/login_test.exs` = 2.36 s wall.
- On a temp copy of the sample app (so the fixture was never modified), same instance OS pid throughout:
  - new `lib/` module + new test file picked up on the next run (`compile: :ok`, file in `reloaded_files`);
  - editing app code changed the test outcome on the next run; editing the test file changed it back;
  - broken app code => `{:error, {:compile_failed, [diagnostic]}}`; deleted test file => `{:error, {:unknown_tests, …}}`;
  - `timeout_ms: 1000` on a test sleeping 2.5 s => failed, `failure.timed_out == true`;
  - `"file:4"` ran 1 test, `counts.excluded` 1; `module_order` controlled start order (checked with `max_cases: 1`);
  - two concurrent `Cook.Pool.run` calls: the second waited (`lock_wait_ms` 2159).
- Recovery (same daemon, temp copy):
  - `kill -9` the Playwright node process while idle: BrowserServer and instance restarted, a run issued
    300 ms after the kill returned 5/5 passed after 2119 ms. Old instance and old node process were gone.
  - `kill -9` it 1.2 s into a full run: that run returned `{:error, {:instance_down, :noconnection}}`;
    the next run passed 5/5 (3847 ms including the re-boot wait).
  - `kill -9` the instance BEAM: status `{:down, …}`, rebooted by itself, next run passed (2764 ms).
- After every driver exit: no `port_wrapper`, `run-server`, `cook_app_*` or Chromium processes of mine left.
- `COOK_POOL=0 mix run -e …`: pool not started, node not distributed.

## Unverified / assumptions
- More than one app in `apps`, and a target app without Ecto (override `prepare: []` per app), were not run.
- Supervisor restart-intensity exhaustion (browser server crash-looping) was not exercised.
- `@tag timeout: n` in a test overrides the cap (ExUnit: tag wins over config); not enforced here.
- Reload of a changed `test/support/**/*.ex` (reloads all test files) is implemented but was not exercised.
- Intermittent login failures (`#flash-info "Welcome back!"` not found, 3 of ~20 early runs) appeared while the
  other agent had debug code in the login flow; none in the final runs. I did not prove they were app-side.

## Not done / next steps
1. Stage 2 builds on `Cook.Pool.run/2`: verdict, persistence, longest-first (`module_order`), HTTP, `bin/cook`.
2. Map errors to `status: "error"`: any `{:error, _}` from `run/2`. Mid-run death is `{:instance_down, _}`.
3. Cap message: for `failure.timed_out` write the "split this test" text; `failure.message` is ExUnit's.
4. README/CI need the `priv/playwright` npm install step.

## Gotchas
- `Kernel.ParallelCompiler.require/2` silently skips files that were already required; test reload uses
  `compile/2`.
- The test helper must run in a process that never exits (it links `PhoenixTest.Playwright.Supervisor`);
  `Cook.Agent.boot/1` keeps a holder process for that and AppInstance monitors it.
- Changes to `test/test_helper.exs` are not picked up without an instance restart.
- Postgres: each instance takes `schedulers * 2` (48) connections from a server with max 100. While an old
  instance was dying and the other agent's `mix test` was running, the new instance logged
  `too_many_connections` for a few seconds (it still became ready). Raise `max_connections` in
  `docker-compose.yml` or lower the sample app's test pool size if this bites.
- The instance's stdout (compiler output, app `IO.puts`, logger) goes to `Cook.Pool.status().instances[].log`
  (last 60 lines only). There is no per-test server log capture yet.
- `run_timeout_ms` (default 600 s) only stops waiting; the run continues on the instance and holds its lock.
- Any `mix run` / `iex -S mix` / `mix phx.server` in dev starts the pool. A second one fails to boot with
  `{:port_in_use, 4041}`. Use `COOK_POOL=0` for side tasks.
- The daemon starts `epmd -daemon`, which outlives it (normal Erlang behaviour). I killed mine afterwards.
- `Cook.Agent*` must not pattern-match on ExUnit structs or call non-stdlib code: they are compiled in Cook
  (no `:ex_unit` dependency, hence `@compile {:no_warn_undefined, …}`) and loaded as binaries on the instance.
- Results cross nodes as plain maps/strings; statuses are atoms. `tests` order is finish order.
- Scheduling granularity is the module; within a module tests run in file order (`seed: 0`).

## Interfaces
```elixir
Cook.Pool.run(path \\ Cook.Pool.default_path(), opts \\ [])
# opts: tests: ["file" | "file:line" | "dir"] (relative to app root; [] = all loaded),
#       module_order: ["MyAppWeb.Features.LoginTest", ...], timeout_ms:, max_cases:, seed: (default 0),
#       reload_tests: false, ready_timeout_ms: 120_000, run_timeout_ms: 600_000
{:ok, %{
  path: "/abs/app", node: :"cook_app_…@host", seed: 0,
  tests: [%{
    id: "test/features/login_test.exs:4", file: "test/features/login_test.exs", line: 4,
    module: "SampleAppWeb.Features.LoginTest", name: "test a user signs in with their password",
    status: :passed | :failed | :skipped | :invalid,
    duration_ms: 367, duration_us: 367_012, started_at_us: <system time µs>, logs: "",
    failure: nil | %{message: String, timed_out: boolean, formatted: String | nil,
                     step_line: integer | nil, step: "source line in the test file" | nil,
                     stacktrace: [%{module: String, function: "name/arity", file: String | nil, line: integer | nil}]}
  }],
  module_failures: [%{module: String, file: String, message: String}],   # setup_all failures
  counts: %{total:, passed:, failed:, invalid:, skipped:, excluded:},
  known_tests: <number of loaded test FILES>, compile: :noop | :ok, reloaded_files: [String],
  timing: %{total_ms:, ready_wait_ms:, first_test_ms: (request -> first test started, nil if none),
            run_ms:, compile_ms:, load_ms:, lock_wait_ms:, agent_ms:, overhead_ms: (total_ms - run_ms)}
}}
{:error, :pool_not_running | {:unknown_app, path} | {:not_ready, status} | {:compile_failed, [diag]}
       | {:test_load_failed, [diag]} | {:unknown_tests, [ref]} | {:instance_down, reason}
       | {:run_timeout, ms} | {:agent_crashed, text}}
# diag: %{file:, line:, severity:, message:}

Cook.Pool.status()        # %{running:, browser_server: %{status: :ready, port:, os_pid:} | nil,
                          #   instances: [%{status: :booting | :attaching | :ready | {:down, reason}, path:, node:, http_port:, boot:, log:}]}
Cook.Pool.default_path()  # absolute path of the first configured app
Cook.Pool.enabled?()
```
Processes stage 2 may monitor: `Cook.Pool.BrowserServer` (registered name) and the instance via
`Cook.Pool.AppInstance.via(path)`; the instance node name comes from `status()` or the run result.
