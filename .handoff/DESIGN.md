# Cook Phase 0 + 1: design decisions

Written by the orchestrator after reading the spec, `phoenix_test_playwright` 0.18,
`playwright_ex`, and ExUnit's source for the installed Elixir. These are decided.
If one turns out to be impossible, say so in your handoff with evidence; do not
quietly do something else.

## Environment (verified)
- Elixir 1.20.4 / OTP 29, Node 24, 24 cores, ~14 GB RAM (be frugal with browsers).
- Postgres: `docker compose up -d --wait` in repo root, listening on **127.0.0.1:5544**
  (user/pass `postgres`). There is no system Postgres.
- Repo root `/home/ryan/code/cook` is the Cook Phoenix app (dev port **4040**).
- `fixtures/sample_app` is the target app (Phoenix 1.8, LiveView, gen.auth, Oban).
  Its browser tests live in `test/features` and run cold with `mix test test/features`.
  In test env it serves on `PORT` (default 4002) and, when `PLAYWRIGHT_WS_ENDPOINT`
  is set, attaches to that Playwright server instead of launching its own browser
  (see its `config/test.exs`, `config/runtime.exs`, `test/test_helper.exs`).
- Playwright npm **1.63.0** is required by `playwright_ex` (minimum supported version).
  Chromium for it is already installed in `~/.cache/ms-playwright`.
- A different agent owns `fixtures/sample_app` app code and tests. Cook agents must
  not edit it, except the single opt-in hook described under "Failure detail".

## User constraints
- Cook's own test suite: **simple unit tests only**, must stay under 30 s, and must
  NOT launch browsers or boot the sample app locally. Anything browser-driven that
  tests Cook itself runs only in GitHub Actions (`.github/workflows/ci.yml`).
- Running the sample app's suite through Cook locally (manual verification, baseline,
  benchmark) is allowed: that is the product working, not Cook's test suite.
- Follow `AGENTS.md` in the repo root (Elixir/Phoenix conventions, one module per file).

## Shape

```
bin/cook (bash + curl, no BEAM boot)
   │ HTTP  POST /api/runs
   ▼
Cook daemon (this Phoenix app, `cook start`)             Cook.Repo (runs, results, durations)
 Cook.Pool.Supervisor (rest_for_one)
  ├─ Cook.Pool.BrowserServer   Port → `node …/playwright/cli.js run-server --port 4041`
  └─ Cook.Pool.AppInstance     Port → separate BEAM node running the target app in
        (one per app path)             MIX_ENV=test, endpoint serving, tests loaded
```

### BrowserServer
- GenServer owning a Port to Playwright `run-server` on 127.0.0.1:4041 (configurable).
  Playwright is installed for Cook at `priv/playwright` (`package.json` pinning
  playwright 1.63.0; `node_modules` git-ignored).
- Ready once the TCP port accepts connections. If the OS process exits, the
  GenServer stops with an error so the supervisor restarts it.
- The node process must die when the GenServer dies (Ports only close stdin). Use a
  small wrapper script that kills the child when stdin closes (pattern in the
  `Port` module docs, "zombie operating system processes").

### AppInstance
- GenServer per target app path. Starts an OS process in that directory, roughly:
  `elixir --sname cook_app_<hash> --cookie <cookie> -S mix run --no-halt`
  with env `MIX_ENV=test`, `PORT=<free port>`, `PLAYWRIGHT_WS_ENDPOINT=ws://127.0.0.1:4041`.
  Run `mix ecto.create --quiet` and `mix ecto.migrate --quiet` first (same env).
- The Cook daemon is itself a distributed node (start distribution at boot with
  `:net_kernel.start/2`, short names; make sure epmd is running). It connects to the
  instance node and **injects** its agent modules (`Cook.Agent.*`) with
  `:code.get_object_code/1` + `:erpc.call(node, :code, :load_binary, …)`. The target
  app does not depend on Cook. Agent modules may use only Elixir/OTP/ExUnit/Mix and
  whatever the target app already has loaded.
- `Cook.Agent.boot/1` (on the instance): `Application.load(:ex_unit)`,
  `Application.put_env(:ex_unit, :autorun, false)`, then
  `Code.require_file("test/test_helper.exs")`. That starts ExUnit without the at-exit
  run and starts the app's `PhoenixTest.Playwright.Supervisor`, which opens ONE
  websocket to the browser server = one warm browser for the instance. Then load all
  test files once so the first run is not cold.
- Same supervision ordering matters: if BrowserServer restarts, instances restart too
  (rest_for_one), because their websocket is dead.

### A run (on the instance, `Cook.Agent.run/1`)
1. Recompile app code in-VM if sources changed (what `IEx.Helpers.recompile/0` does).
   Hot reload is the Phase 1 choice; restart-vs-reload is an open question to measure.
2. (Re)load only new/changed test files (track mtime). Set
   `Code.compiler_options(ignore_module_conflict: true)`.
3. `ExUnit.configure/1`: `formatters: [Cook.Agent.Formatter]`, `timeout: <cap ms>`
   (per-test cap, default 10_000), `max_cases`, and filters for an explicit test list
   (`ExUnit.Filters.parse_paths/1` gives the include/exclude for `file:line`).
   **Never configure retries; there are none.**
4. `ExUnit.run(modules)` with `modules` in the order Cook wants. Facts from ExUnit source:
   - `ExUnit.run/1` re-registers each given module via `module.__ex_unit__(:config)` and
     runs them; this is how loaded modules are re-run without recompiling.
   - Async modules are taken from a FIFO queue, `max_cases` at a time, so list order =
     start order. Tests inside one module run serially: **scheduling granularity is the
     module**, not the test. Longest-first means ordering modules by recorded total
     duration, descending.
   - Modules register themselves in `ExUnit.Server` when their file is loaded. Loading
     files outside a run therefore leaves them queued; clear that before an ordered run
     (e.g. an empty run with `only_test_ids: MapSet.new()` and no formatters), or the
     load order wins over yours.
5. The formatter (a GenServer receiving `{:test_started, t}`, `{:test_finished, t}`,
   `{:suite_finished, times}` casts) collects per-test results and returns them plus
   timings (compile ms, load ms, time to first `test_started`, run ms).

### Run coordination (daemon side)
- One run at a time per instance; callers queue.
- The coordinator monitors both the BrowserServer process and the instance node for the
  duration of a run. If either goes down mid-run the verdict is `status: "error"` with a
  reason. The supervisor restarts the pool; the next run waits for readiness (bounded
  timeout) and then runs normally.
- If a run arrives for an instance that is not ready, that is a pool bug per the spec:
  wait (bounded), and record the wait in `overhead_ms`.

### Verdict (`cook.verdict/1`)
Keys exactly as in the spec's draft. Additive fields are allowed (e.g. `run_id`, `seed`,
`counts`, `timing.first_test_ms`, `error`). Phase 1 values:
- `selected` = tests run, `skipped` = known tests not run, `selection_reason` =
  `"all"` or `"explicit"`. No impact map yet.
- `quarantined` = `[]` (flake ledger is Phase 2), but every test result is stored so
  pass rates can be computed later.
- A test over the cap fails with a message that says to split the test.
- `repro` = `cook run <path> <file>:<line>`.

### Failure detail (best effort in Phase 1, in this priority)
1. `test` (file:line), `message`, `step` (source line of the failing call, from the
   stacktrace entry in the test file), `repro`. These come from ExUnit alone.
2. `trace`: enable `trace: true` in the instance's `:phoenix_test, :playwright` config
   with `trace_dir` under the run's artifacts dir, if the measured cost is acceptable;
   otherwise leave null and note the measurement.
3. `dom_snapshot`, `console_errors`, `server_logs` need to know which browser page and
   which processes belong to a test. Allowed integration point: ONE optional setup hook
   in the sample app's `test/support/feature_case.ex`, guarded so the app still works
   without Cook:
   `setup context do if Code.ensure_loaded?(Cook.Agent), do: Cook.Agent.track(context); :ok end`
   `Cook.Agent.track/1` may register an `on_exit` and record test pid / page ids. The
   sandbox owner in the request User-Agent is the test pid
   (`Phoenix.Ecto.SQL.Sandbox.metadata_for(repos, self())` in the library's Case), which
   is how request/LiveView processes can be tied back to a test for log tagging.
   If any of these three cannot be done cleanly, return `null`/`[]` and document why.

### Persistence (Cook.Repo, Postgres)
`runs` (status, timings, counts, path) and `test_results` (run id, test id `file:line`,
module, name, status, duration ms). Durations for scheduling come from recent results.

### CLI and HTTP
- `bin/cook start` (boot daemon), `bin/cook run [PATH] [TEST...] [--json]`, `bin/cook status`.
  `run` is bash + curl against the daemon; no BEAM boot on the hot path.
- Exit codes: 0 pass, 1 fail, 2 error. `--json` prints the verdict JSON only; without it
  a short human summary rendered by the daemon.
- Default PATH is the configured sample app.

### Phase 0 baseline and benchmark
- `bin/baseline`: copies the committed sample app to a temp dir (no `_build`, `deps`,
  `node_modules`), then times each cold phase separately: deps fetch, npm install,
  browser install, compile, assets build, DB create+migrate (fresh DB name), test run.
  Writes `bench/baseline.json` (committed). Hex/npm/browser download caches on this
  machine are warm; say so in the JSON so the number is not oversold.
- `mix cook.bench`: 20 warm runs through `bin/cook run --json`, measuring wall time from
  outside the CLI; reports p50/p95 against the baseline and writes `bench/warm.json`.

## Stages (one agent each, in order)
1. `pool`: BrowserServer, AppInstance, agent injection, `Cook.Agent` boot/run/formatter,
   pool supervisor. Deliverable: a function that runs the sample suite on the warm
   instance and returns raw per-test results and timings.
2. `runs`: run coordinator with crash handling, verdict v1, persistence, longest-first,
   failure detail, HTTP API, `bin/cook`.
3. `bench`: baseline script, benchmark task, CI workflow, README, acceptance checklist.
