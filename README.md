# Cook

Cook is a warm end-to-end test runner for Phoenix apps. A daemon keeps a
Playwright browser server and a booted copy of the target app (in `MIX_ENV=test`,
with its test files loaded) running, so a test run skips dependency fetching,
compilation, app boot and browser launch. Each run returns one JSON verdict that
a person or an agent can act on.

This repository contains Phase 0 (a cold baseline) and Phase 1 (a warm
single-node runner) together with a sample app, `fixtures/sample_app`, that is
used as the test target.

## Prerequisites

- Elixir 1.20 / Erlang/OTP 29 (developed on 1.20.4 / 29.0.6)
- Node.js 24 and npm
- Docker (for Postgres), `curl`, `jq`, `psql`
- Linux. Nothing else has been tried.

## Setup

```sh
docker compose up -d --wait          # Postgres on 127.0.0.1:5544 (user/password postgres)

mix deps.get                          # Cook itself

cd fixtures/sample_app                # the target app
mix deps.get
npm ci --prefix assets
MIX_ENV=test mix do assets.setup + assets.build
cd ../..

(cd priv/playwright && npm ci && npx playwright install chromium)
```

`bin/cook start` creates and migrates Cook's own database (`cook_dev`) and the
sample app's test database on first use.

## Cold baseline

```sh
bin/baseline        # one run
bin/baseline 3      # three runs, median recorded, every run listed
```

`bin/baseline` exports the committed `fixtures/sample_app` with `git archive`
into a temp dir (no `_build`, `deps` or `node_modules`) and times each phase:
deps fetch, `npm ci`, Playwright browser install, compile, assets build,
database create and migrate (on a database of its own), and
`mix test test/features`. It writes `bench/baseline.json` and removes the temp
dir and the database. Stop the daemon first; do not run it next to the
benchmark.

The baseline is a lower bound for CI: the Hex, npm and Playwright browser
caches on the machine are warm, and there is no VM provisioning, queueing or
network checkout.

## Warm runs

```sh
bin/cook start --detach     # boots the daemon in the background, returns when the pool is ready
bin/cook status             # exit 0 when ready, 2 otherwise
bin/cook run                # full sample suite, short human summary
bin/cook run --json         # full suite, prints only the verdict JSON
bin/cook run test/features/login_test.exs        # one file
bin/cook run test/features/login_test.exs:4      # one test (file:line)
bin/cook stop
```

`bin/cook start` without `--detach` runs the daemon in the foreground. The
daemon listens on `127.0.0.1:4040`, the browser server on `127.0.0.1:4041`;
logs go to `tmp/cook.log`. `bin/cook run` is bash and curl, so the CLI adds
tens of milliseconds, not a VM boot. Test paths are relative to the app root.
The daemon only serves the apps configured under `config :cook, Cook.Pool`
(by default the sample app).

Exit codes of `bin/cook run`:

| code | meaning |
| --- | --- |
| 0 | `pass`: every selected test passed |
| 1 | `fail`: at least one test failed |
| 2 | `error`: the run could not be completed (browser server or app instance died, compile error, unknown test, daemon unreachable). When the daemon is unreachable stdout is empty. |

Environment: `COOK_PORT` (4040), `COOK_URL`, `COOK_TRACE=1` (set when starting
the daemon), `COOK_RUN_TIMEOUT` (seconds, 900), `COOK_START_TIMEOUT` (seconds, 180).

Tests are never retried. A test that fails is reported once, as a failure.
A test that runs longer than the per-test cap (10 s) fails with a message that
says to split it.

## Benchmark

```sh
bin/cook start --detach
mix cook.bench              # 20 warm full-suite runs, writes bench/warm.json
bin/cook stop
```

`mix cook.bench` calls `bin/cook run --json` 20 times and measures wall time
around the whole CLI process. It reports p50/p95 (nearest rank) of the wall
time, of the verdict's `duration_ms` and `timing.first_test_ms`, and the
speedup against `total_ms` in `bench/baseline.json`. Options: `--runs N`,
`--baseline PATH`, `--out PATH`.

## Measured numbers

Measured on 2026-10-04 on one workstation (AMD Ryzen AI 9 HX 370, 24 threads,
15 GB RAM, Linux, Elixir 1.20.4 / OTP 29, Node 24). The sample suite has 44
browser tests. The full data is in `bench/baseline.json` and `bench/warm.json`.

Cold baseline, median of 3 runs: **47.3 s**.

| phase | ms (median) |
| --- | --- |
| deps fetch | 6778 |
| npm install | 221 |
| browser install (already cached) | 513 |
| compile | 27703 |
| assets build | 4442 |
| database create + migrate | 551 |
| `mix test test/features` | 7041 |

Warm, 20 full-suite runs through `bin/cook run --json`:

| | p50 | p95 |
| --- | --- | --- |
| CLI wall time | 5321 ms | 5426 ms |
| verdict `duration_ms` | 5296 ms | 5400 ms |
| `timing.first_test_ms` | 43 ms | 52 ms |
| CLI start to first test | 68 ms | 77 ms |

Speedup against the baseline: **8.89x at p50**, 8.71x at p95. This is below
the 10x target set for this phase. The warm run cannot get shorter than its
longest test module (about 5.3 s, with one 4.4 s test), because tests inside a
module run serially; the cold test phase alone is 7.0 s for the same reason.
The saving is the 40 s of setup, not the test time.

Verdicts in those 20 runs: 14 pass, 6 fail, 0 error. The failures are the
sample app's deliberately flaky test (`delivery_estimate_test.exs:8`), reported
once per failing run and not retried. In one run a second test
(`product_management_test.exs:6`) also failed; it is not marked flaky.

After the browser server or the app instance is killed, the next run waits for
the pool to come back: `first_test_ms` was 0.85 s and 1.6 s in those cases.

## Verdict

`bin/cook run --json` prints a `cook.verdict/1` document. Populated on every run:

- `schema`, `run_id`, `status` (`pass`, `fail`, `error`), `path`, `duration_ms`, `seed`
- `selected` (tests run), `skipped` (known tests not run), `selection_reason` (`all` or `explicit`)
- `counts` (`passed`, `failed`, `known`)
- `timing`: `overhead_ms`, `tests_ms`, `slowest_test_ms`, `first_test_ms`, `queue_ms`, `ready_wait_ms`, `compile_ms`, `load_ms`
- `failures`: one entry per failed test with `test` (`file:line`), `name`, `module`,
  `kind` (`assertion`, `cap`, `setup_all`), `message`, `step` (the source line of the
  failing call), `repro` (a `cook run` command), `duration_ms`, `dom_snapshot`
  (path to an HTML file under `artifacts/`), `console_errors`, `server_logs`

Null or empty by default:

- `error` is `null` unless `status` is `error`; then it has `reason` and `message`.
- `failures[].trace` is `null`. Tracing costs about 0.5 s per full run, so it is
  off unless the daemon is started with `COOK_TRACE=1`; then it is the path to a
  Playwright trace zip.
- `quarantined` is always `[]` (no flake ledger yet).
- `console_errors` and `server_logs` are `[]` when the test produced none. The
  sample app logs at `:warning` in test, so `server_logs` is usually empty.
- `dom_snapshot`, `console_errors` and `server_logs` need the opt-in hook in the
  app's feature case (see `fixtures/sample_app/test/support/feature_case.ex`);
  without it they are `null`/`[]`.

Artifacts of the last 20 runs are kept in `artifacts/` (git-ignored).

## Known limitations

- Scheduling granularity is the test module. Tests inside a module run
  serially, and longest-first ordering orders modules, not tests.
- One browser per app instance, one app instance per configured app, one run
  at a time per instance (further runs queue).
- Code changes are hot-reloaded in the instance; changes to
  `test/test_helper.exs` need a daemon restart.
- A run that hits the run timeout keeps running on the instance and holds its lock.
- Killing the wrapper shell of the browser server (rather than the node
  process) is not noticed by the pool.
- Not built (Phase 2 and later): test selection by impact, flake ledger and
  quarantine, a GUI, a GitHub App, multi-node pools.
- Only tried with the sample app, on Linux.

## Tests and CI

`mix precommit` runs Cook's own tests. They are unit tests only: no browser, no
sample app boot, under a second.

GitHub Actions (`.github/workflows/ci.yml`) has two jobs:

- `unit`: compile with warnings as errors, format check, `mix test`.
- `e2e`: builds the sample app, installs Playwright, starts the daemon, runs the
  sample suite through `bin/cook run --json` and checks the verdict; then kills
  the browser server mid-run, expects exit code 2, and checks that the next run
  completes. Browser-driven checks of Cook itself run only in this job.
