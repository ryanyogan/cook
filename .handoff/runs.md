# Stage 2: runs

## Status
COMPLETE (2026-10-04). Two things are implemented but not exercised with real content:
`console_errors` and `server_logs` (see Unverified).

## Done
- `lib/cook/verdict.ex`: `cook.verdict/1`. Version string only in `Cook.Verdict.schema/0`. `build/2`,
  `test_rows/2`, `effective_status/2` (cap rule), `exit_code/1`, `to_json/1` (stable key order), `summary/1`.
- `lib/cook/runs.ex` (context: `run/3`, `status/0`, `record/2`, `module_order/1`, `recent_durations/1`,
  `recent/1`, `normalize_tests/2`), `lib/cook/runs/coordinator.ex` (one run at a time per app path, FIFO
  queue, crash => error verdict), `lib/cook/runs/runner.ex` (bounded wait for a ready pool, watches the
  browser server during the run, builds the verdict, persists, prunes artifacts),
  `lib/cook/runs/ordering.ex`, `lib/cook/runs/run.ex`, `lib/cook/runs/test_result.ex`.
- Migrations `priv/repo/migrations/20261004160439_create_runs.exs`, `…160441_create_test_results.exs`.
  `test_results.started_ms` = start offset after the run's first test (ordering evidence, later waterfall).
- `lib/cook_web/controllers/run_controller.ex` (`POST /api/runs`), `status_controller.ex` (`GET /api/status`),
  routes in `lib/cook_web/router.ex`. Exit code travels in the `x-cook-exit-code` response header.
- `bin/cook` (bash + curl): `start [--detach]`, `stop`, `run [PATH] [TEST...] [--json]`, `status [--json]`.
- Failure detail, instance side: `lib/cook/agent/tracker.ex` (new, injected), `Cook.Agent.track/1`,
  `Cook.Agent.trace_prefix/2`, artifacts handling in `Cook.Agent.run/1` (`:artifacts_dir`, `:trace`).
- The one sample-app edit: a guarded `setup` inside the `using` block of
  `fixtures/sample_app/test/support/feature_case.ex` (after `use PhoenixTest.Playwright.Case`).
- Stage 1 files touched (additive): `lib/cook/agent.ex` (track, artifacts, `known_test_count`),
  `lib/cook/pool.ex` (`:artifacts_dir`, `:trace` opts, `known_test_count` in the result),
  `lib/cook/pool/app_instance.ex` (injects `Cook.Agent.Tracker` too), `lib/cook/application.ex`
  (Task.Supervisor, Coordinator, `COOK_PIDFILE`), `config/config.exs` (`Cook.Pool trace: false`, `Cook.Runs`),
  `config/runtime.exs` (`COOK_TRACE`, `COOK_DAEMON`), `config/test.exs` (stub pool), `.gitignore` (`/artifacts/`, `/tmp/`).
- Tests (no browser, no app boot): `test/cook/verdict_test.exs`, `test/cook/runs_test.exs`,
  `test/cook/runs/{ordering,coordinator}_test.exs`, `test/cook/agent/tracker_test.exs`, `test/cook/cli_test.exs`,
  `test/cook_web/controllers/run_controller_test.exs`, stub `test/support/pool_stub.ex`.

## Verified
All on this machine, 2026-10-04, real sample app, through `bin/cook` only.
- `mix precommit`: 73 tests pass, ExUnit 0.1 s, 0.66 s wall (`time`).
- `bin/cook start --detach`: ready in 1.75 s wall (everything already compiled).
- 5 consecutive `bin/cook run --json` on the full suite (44 tests), final code, trace off:

  | run | exit | status | CLI wall ms | duration_ms | timing.first_test_ms | overhead_ms |
  | --- | --- | --- | --- | --- | --- | --- |
  | 1 | 0 | pass | 5517 | 5477 | 26 | 32 |
  | 2 | 1 | fail (flaky) | 5368 | 5334 | 29 | 32 |
  | 3 | 0 | pass | 5383 | 5356 | 50 | 54 |
  | 4 | 1 | fail (flaky) | 5323 | 5291 | 44 | 48 |
  | 5 | 0 | pass | 5277 | 5258 | 44 | 47 |

  CLI wall minus `duration_ms` was 19-40 ms. `slowest_test_ms` is about 4.4 s (the floor of a full run).
- Top-level keys of a real verdict: `schema, run_id, status, path, duration_ms, timing, selected, skipped,
  selection_reason, counts, failures, quarantined, error, seed`. Its timing:
  `{"overhead_ms":30,"tests_ms":5692,"slowest_test_ms":4424,"first_test_ms":24,"queue_ms":2,"ready_wait_ms":0,"compile_ms":18,"load_ms":0}`.
- `bin/cook run fixtures/sample_app test/features/login_test.exs:4 --json`: exit 0, `selected 1, skipped 43,
  selection_reason "explicit"`, 255 ms. A whole file: `selected 5, skipped 39`. Unknown file: exit 2, `unknown_tests`.
- Flaky test (`delivery_estimate_test.exs:8`): failed in 4 of 10 full runs; each time exactly one entry in
  `failures`, never retried. Populated: `test`, `name`, `module`, `kind: "assertion"`,
  `step: "|> assert_has(\"#delivery-estimate\", text: \"Arrives in\")"`,
  `message: "Could not find element \"#delivery-estimate\" [text: \"Arrives in\"]"`, `repro`,
  `duration_ms`, `dom_snapshot` (absolute path, 11 KB HTML of the page when the test exited).
  `console_errors: []` and `server_logs: []` (nothing was emitted, see Unverified). `trace: null` by default;
  with `COOK_TRACE=1` it was an absolute path to a 185 KB zip.
- Trace cost, full suite, same daemon otherwise: trace off `duration_ms` 5258-5803 (12 runs, median about 5350);
  trace on 6191 / 5950 / 5854 / 5830. Tracing costs about 0.5 s (9 %) per full run, so it is OFF by default
  and failures get the DOM snapshot. Opt in with `COOK_TRACE=1 bin/cook start`.
- Kill the Playwright node process (`kill -9`) 1.5 s into a full run: CLI returned 29 ms later, exit 2,
  `error.reason "browser_server_down"`. Next `bin/cook run test/features/login_test.exs`: exit 0 in 2175 ms
  (`first_test_ms` 900, the wait for the pool). Then a full run passed 44/44. Same daemon pid throughout.
- Kill the instance BEAM (`kill -9`) 1.5 s into a full run: exit 2, `error.reason "app_instance_down"`.
  Next run: exit 0 in 3332 ms (`first_test_ms` 1944). Same daemon pid.
- Longest-first: module totals of one full run were OrderHistory 5352, ProductImport 2900, ProductManagement
  2259, Ordering 2068, Reports 1985, DeliveryEstimate 1625, Login 1611, ChatBroadcast 1446, Settings 1360,
  Chat 1202, Home 884, …; in the next run exactly those first 8 (`max_cases` 8) started at +0 ms, then
  Settings (+1414), Chat (+1478), Home (+1909) (`test_results.started_ms`).
- `bin/cook stop`: afterwards no `port_wrapper`, `run-server`, `cook_app_*`, `phx.server`, Chromium or epmd
  processes (I killed the epmd the daemon had started; none existed before).

## Unverified / assumptions
- `console_errors` (console `error` messages and page errors of the test's browser context, via a
  `PlaywrightEx.subscribe/2` collector) and `server_logs` (logger handler + telemetry on
  `[:phoenix, :endpoint, :start]` / `[:phoenix, :live_view, :mount, :start]`, owner taken from the sandbox
  metadata in the User-Agent) are implemented but came back empty in every real failure: the flaky test
  produces no console error, and the sample app logs at `:warning` in test, so no line was emitted.
  Whether `page_error` arrives on the context channel is an assumption.
- Sessions opened with `new_browser_session/1` are not covered by the snapshot or the console collector.
- The sample app's cold `mix test` was not re-run after adding the hook (it compiled and ran under Cook).
- Phoenix's code reloader is still in the request path of the daemon (dev env); total overhead was 30-54 ms
  so I left it. Not measured separately.
- Queueing of two concurrent `bin/cook run` calls: unit-tested with a stub, not run for real.

## Not done / next steps
1. Stage 3: baseline, `mix cook.bench`, CI, README. README needs: `bin/cook` commands, `COOK_TRACE`, artifacts dir.
2. Exercise `console_errors` / `server_logs` on a temp copy of the sample app with a test that logs a warning
   in a LiveView and calls `console.error`.
3. Postgres connections: see Gotchas; raise `max_connections` in `docker-compose.yml` (e.g. `command: postgres -c max_connections=300`).

## Gotchas
- `too_many_connections` hit once: a `COOK_POOL=0 mix run` side task (10 connections) while the daemon (10) and
  the instance (48) were up next to the other agent's work, against a server with max 100. It retried and
  worked. I did not restart Postgres.
- `Cook.Pool.status().browser_server.os_pid` is the wrapper shell, not node. `kill -9` on the wrapper orphans
  node; the pool does not notice and keeps working (the run passed). Kill the `node … run-server` process to
  simulate a browser-server crash. Stage 1 behaviour, not changed.
- Starting a daemon right after one exits failed with `{:port_in_use, 4041}` (node dies a moment after the
  VM). `bin/cook stop` now waits until the pool's wrapper processes are gone.
- `bin/cook run`: when the daemon is unreachable, stdout is empty (no verdict exists), a message goes to
  stderr and the exit code is 2. Agents must treat empty stdout + exit 2 as an error.
- The first argument of `run` is the app only if it is a directory with a `mix.exs`; test paths are relative
  to the app root (absolute paths below the app are accepted).
- `pgrep -f` with a pattern that also matches your own shell command line kills your shell; use `[r]un-server`.
- The hook must sit after `use PhoenixTest.Playwright.Case` in the `using` block: a `setup` in the case
  template itself runs before Playwright's, has no `:conn`, and its `on_exit` would run after the page closed.
- DOM snapshots are taken for every tracked test at exit (ExUnit gives `on_exit` no pass/fail), then deleted
  for passing tests. Artifacts of the last 20 runs are kept in `artifacts/` (git-ignored); abandoned runs keep none.
- A verdict loaded back from `runs.verdict` has string keys; `Verdict.summary/1` needs the fresh one.

## Interfaces
```
bin/cook start --detach     # migrates cook_dev, boots the daemon in the background, returns when ready
                            # (pid in tmp/cook.pid, log in tmp/cook.log); `bin/cook start` = foreground
bin/cook run [PATH] [TEST...] [--json]   # exit 0 pass, 1 fail, 2 error; --json prints only the verdict
bin/cook status [--json]    # exit 0 ready, 2 not ready / unreachable
bin/cook stop               # SIGTERM, waits for the VM and the pool's OS processes
pkill -x epmd               # optional: the daemon's epmd outlives it
# env: COOK_PORT (4040), COOK_URL, COOK_TRACE=1, COOK_RUN_TIMEOUT (s, 900), COOK_START_TIMEOUT (s, 180)
```
```
POST /api/runs    form or JSON params: path, tests[] , format=json|text   -> 200, header x-cook-exit-code
GET  /api/status  ?format=json|text                                        -> 200, header x-cook-exit-code
```
```elixir
Cook.Runs.run(path \\ nil, tests \\ [], opts \\ [])   # always returns a verdict map (atom keys)
Cook.Verdict.schema()                                 # "cook.verdict/1"
Cook.Verdict.to_json(verdict) | summary(verdict) | exit_code(verdict)
Cook.Runs.module_order(path) | recent_durations(path) | recent(limit)
```
Verdict (additive to the spec draft): `run_id`, `path`, `counts {passed, failed, known}`, `error {reason, message}`,
`seed`, `timing.{first_test_ms, queue_ms, ready_wait_ms, compile_ms, load_ms}`, and per failure `name`, `module`,
`kind` (`assertion | cap | setup_all`), `duration_ms`. `duration_ms` is request received to verdict built;
`first_test_ms` is request received to first test started (includes queue and pool wait).
`error.reason`: `browser_server_down, app_instance_down, pool_not_ready, pool_not_running, unknown_app,
unknown_tests, compile_failed, test_load_failed, run_timeout, agent_crashed, runner_crashed, unexpected`.
