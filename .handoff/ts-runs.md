# ts-runs (TypeScript engine, stage 2: daemon, run coordination, verdict, store, CLI)

## 2026-10-04

### Status
COMPLETE

### Done
All paths relative to `packages/cook`. Nothing outside it was changed except this file. Not committed.
The Elixir code, `fixtures/` and `spike/` were not touched.

- `src/daemon.ts`: the daemon. Effect program run with `NodeRuntime.runMain`: HTTP server on
  `127.0.0.1:COOK_PORT` (default 4050, `NodeHttpServer.layer` + `HttpRouter.serve` from `effect/http`), the
  coordinator, the store and `PoolLive` from stage 1 in one layer. `POST /api/stop`, SIGTERM and SIGINT all leave
  the same scope, which stops the server, the pool (process trees included) and closes the database.
- `src/Api.ts`: the routes (see Interfaces). Request body and stored verdicts are decoded with Effect Schema.
- `src/Coordinator.ts`: `makeCoordinator(deps)` (pure of the pool: takes `run`, `snapshot`, `store` as
  functions, so it is unit tested with stubs) and the `Coordinator` service that wires it to the real pool.
  One semaphore per canonical project path; other paths run alongside. A run always ends with a verdict:
  engine errors, a run timeout (`COOK_RUN_TIMEOUT_MS`, default 15 min) and defects become `error` verdicts.
- `src/Classify.ts`: `classify(before, after)`, pure. See "Crash classification" below.
- `src/Report.ts`: `testRows(report)` flattens Playwright's JSON report (file relative to the config
  directory, describe path, project, status, duration, start offset, message without ANSI codes, failing step,
  attachment paths); `globalErrors(report)`.
- `src/Verdict.ts`: the `Verdict` Effect Schema (`cook.verdict/1`), `buildVerdict(input)` (pure), `exitCode`,
  `summary` (the human text), `encodeVerdict` / `decodeVerdict`. The HTTP response is the schema's encoding; the
  CLI prints what the daemon sends (JSON, or the summary rendered by the daemon from the same value).
- `src/Trace.ts`: a small zip reader (central directory, stored and deflated entries) and
  `consoleErrorsFromTrace`: console `error` messages and uncaught page errors from a Playwright trace.
- `src/Store.ts` (`openStore`, plain `node:sqlite`), `src/StoreService.ts` (Effect service, file
  `$COOK_HOME/cook.sqlite`, WAL, migrations by `PRAGMA user_version`).
- `bin/cook.mjs`: the CLI. Plain JavaScript, imports only `node:` built-ins; `cook start` (foreground) is the
  only path that imports `src/daemon.ts`. It uses `node:http`, not `fetch` (undici's 300 s headers timeout
  would cut off a long run). `package.json` has `"bin": { "cook": "bin/cook.mjs" }` and `npm run cook --`.
- Stage 1 files changed, additively: `src/WebServer.ts` (`snapshot(project)` and `acceptingFor(entry)`),
  `src/index.ts` (exports), `biome.json` (`bin/**`), `package.json` (bin, script).
- Tests (no browser, no app): `test/Verdict.test.ts` (uses `test/fixtures/report-failed.json`, three tests cut
  from a real report of the fixture's flaky test, machine paths replaced), `test/Classify.test.ts`,
  `test/Coordinator.test.ts` (queueing, giving up while queued, classification through stubs, settle wait,
  error mapping, timeout), `test/Store.test.ts`, `test/Trace.test.ts`, `test/cli.test.ts`.

### Crash classification (the Elixir bug, not repeated)
The runner's result is never raced against a server's exit. After the runner has exited, the coordinator takes
a snapshot of the pool and compares it with the servers the run was handed (`RunResult.pool`):
- gone from the pool -> `gone_at_run_end`
- listed as starting or failed -> `not_ready_at_run_end`
- ready, but another guard pid or start count -> `restarted_during_run`
- ready with the same pid, but its port refuses a TCP connection -> `not_accepting_at_run_end` (the process is
  dead and the pool has not noticed yet; the kernel closes the port at once, the exit notice comes later)
The browser server is checked first. The verdict is `error` with reason `browser_server_down` or
`web_server_down`, the message names the server (a web server with its command), `failures` is `[]`.
The port check is a TCP connect, not the HTTP readiness probe, so a busy dev server is not taken for a dead one.
Before every run the coordinator also waits (at most 5 s) while a server is listed ready with a closed port, so
the run after a crash is not handed a dead endpoint; the supervisor from stage 1 then restarts it and the
runner waits for that as usual.

### Verified
All on this machine, 2026-10-04, final code unless noted, `COOK_HOME` in the session scratchpad,
`COOK_PORT=43050`, fixture on `PORT=43917`. Load average was 9 to 27 the whole time (other agents), so wall
times are worse and noisier than stage 1's.
- `npm run check`: typecheck clean, biome clean, 10 test files, 50 tests passed, 1.8 to 2.7 s.
- `cook start --detach`: ready in 295 ms and 501 ms (two starts). Second `start --detach`: "already running",
  exit 0. Port held by a non-Cook HTTP server: exit 2 in 48 ms, "port 43052 is in use by something that is not
  a cook daemon". Daemon dies at start (`COOK_PORT=1`, EACCES): exit 2 in 343 ms with the log tail. Unwritable
  `COOK_HOME`: exit 2 in 35 ms.
- Full runs through `cook run <fixture> --env PORT=43917 --json` (45 tests, 12 workers, warm pool). Wall is
  from before `node` starts to the CLI's exit:

  | run | exit | status | wall ms | duration_ms | first_test_ms | overhead_ms | client_ms | load |
  |---|---|---|---|---|---|---|---|---|
  | full1 | 0 | pass | 11749 | 11698 | 799 | 873 | 42 | 9.0 |
  | full2 | 0 | pass | 11054 | 11000 | 614 | 684 | 44 | 9.3 |
  | full3 | 1 | fail (flaky) | 11325 | 11264 | 814 | 887 | 53 | 11.0 |
  | full4 | 1 | fail (reports:13) | 11454 | 11394 | 763 | 868 | 33 | 14.6 |
  | full5 | 0 | pass | 14492 | 14408 | 1302 | 1379 | 76 | 14.9 |
  | f1 | 1 | fail (reports:13) | 11212 | 11157 | 630 | 700 | 46 | 12.9 |
  | f2 | 0 | pass | 11421 | 11380 | 746 | 814 | 34 | 12.8 |
  | f3 | 0 | pass | 14863 | 14813 | 708 | 803 | 33 | 15.0 |
  | f4 | 0 | pass | 13056 | 12937 | 948 | 1023 | 111 | 14.7 |
  | f5 | 0 | pass | 12123 | 12074 | 656 | 750 | 31 | 16.8 |
  | f6 | 0 | pass | 14803 | 14693 | 1538 | 1628 | 86 | 19.4 |

  Wall p50 11.7 s, min 11.05 s, max 14.9 s (stage 1: about 10.9 s at load 4 to 17). Spawn to first test
  (`timing.runner_start_ms`) p50 762 ms, min 614 ms (stage 1: 0.65 to 0.75 s). The coordinator, verdict and
  store add under 0.1 s: wall minus `duration_ms` was 41 to 119 ms, and `overhead_ms` minus `runner_start_ms`
  about 70 ms. The slower runs are the tests themselves (`tests_ms` 76 to 105 s summed) on a loaded machine.
- `cook run` invoked to the request reaching the daemon (`timing.client_ms`, start taken with `date` in the
  shell before `node` is started): 31 to 53 ms in most of about 30 runs, 60 to 111 ms in the rest (load
  above 14). `cook status` against no daemon, process start to exit: 60 to 96 ms.
- One `file:line`: `cook run <fixture> --env PORT=43917 e2e/import.spec.ts:32 --json`: exit 0, `selected 1,
  skipped 44, selection_reason "explicit"`, `counts.known 45`, 3968 ms wall. One file before any full run:
  `selected 3, skipped 0, counts.known null`.
- Failing run (full3): exit 1, exactly one entry in `failures`, the test ran once (45 rows in `test_results`,
  one `failed`). Entry: `test "e2e/estimate.spec.ts:6"`, `kind "assertion"`, `step "expect(await
  page.getByRole('alert').count(), 'the estimator answered with an error').toBe(0)"`, message without colour
  codes, `trace` = `$COOK_HOME/runs/<id>/artifacts/1-trace.zip` (copied, 60 KB), `dom_snapshot` =
  `.../1-error-context.md`, `console_errors: []`, `repro "cook run /home/ryan/code/cook/fixtures/react_app
  --env PORT=43917 e2e/estimate.spec.ts:6"`. Without `--json` the same run prints a `FAIL 1 of 45 tests failed
  in 11.3 s (...)` summary with message, step, trace, page and repro.
- Per-test cap: `--timeout 1000 e2e/import.spec.ts:32`: exit 1, `kind "cap"`, message "Stopped at the per-test
  cap of 1000 ms. Split this test into smaller tests (Test timeout of 1000ms exceeded.)", `step null`.
- Two `cook run` at once (a full run, then 0.3 s later one file): `cook status` showed "running, 1 queued";
  the first finished in 13 262 ms, the second reported `queue_ms 12916`, both exit 0.
- Kills, `kill -9` of the pid found under the pool's own guard (never by name), then a one-file run:

  | killed | after s | exit | status | error.reason | why | verdict ms | next run |
  |---|---|---|---|---|---|---|---|
  | `run-server` node | 3 | 2 | error | browser_server_down | restarted during run | 4422 | pass, 1788 ms |
  | `run-server` node | 1 | 2 | error | browser_server_down | restarted during run | 2786 | pass, 1852 ms |
  | `run-server` node | 7 | 2 | error | browser_server_down | not ready at run end | 7113 | pass, 2103 ms (waited 226 ms) |
  | Vite dev server | 3 | 2 | error | web_server_down | restarted during run | 12161 | pass, 1917 ms |
  | Vite dev server | 6 | 2 | error | web_server_down | restarted during run | 12598 | pass, 2273 ms |
  | Vite dev server | 1.5 | 2 | error | web_server_down | restarted during run | 18534 | pass, 4095 ms |

  Message example: "web server webServer[0] (`npm run dev`) died during the run (restarted during run). ...".
  Same daemon pid throughout. `run-server` killed while idle and a run started at once: pass, `ready_wait_ms`
  408. A full run afterwards: 44 passed, 1 failed (reports:13, see Gotchas).
- Other errors: unknown file -> exit 2 `unknown_tests`; a directory without a Playwright config -> exit 2
  `unknown_project`; no daemon -> stderr message, empty stdout, exit 2.
- Store after the session: `runs` by status: 21 pass, 5 fail, 3 `browser_server_down`, 3 `web_server_down`,
  1 `unknown_project`, 1 `unknown_tests`; 889 rows in `test_results`. `GET /api/runs/<id>?tests=1` returned the
  45 rows of a run.
- `cook stop`: 233 ms. Afterwards the daemon, both guards and their children (checked by pid) were gone, ports
  43050 and 43917 were free, `.cook-playwright.config.mjs` was gone from the fixture, `~/.cook` does not exist.

### Failure detail: what is filled and what is null
Nothing is injected into the target project and no Playwright flag about tracing is passed, so:
- `trace`: the trace zip when the project's own config kept one (the fixture: `retain-on-failure`), copied to
  `$COOK_HOME/runs/<id>/artifacts/` because Playwright wipes the project's output directory on its next run.
  `null` when the project records no trace.
- `console_errors`: read from that trace. `[]` when the trace has none (every real failure today), `null` when
  there is no trace, because without one there is nowhere to get them without changing the project.
- `dom_snapshot`: Playwright's own `error-context.md` attachment (markdown with an ARIA snapshot of the page
  at the failure), copied likewise. It is not HTML. `null` when Playwright wrote none (older versions, or
  outside a page).
- `server_logs`: always `[]`. The web server's log (`$COOK_HOME/logs/web-server-*.log`) is shared by all
  workers and cannot be attributed to one test.
- `step`: the source line Playwright marks in its snippet. `null` for a test stopped at the cap (the timeout
  error has no snippet) and for errors without a location.
- `seed`: always `null` (Playwright has none). `quarantined`: always `[]`.
- Not carried over from the Elixir verdict: `failures[].module`, `timing.compile_ms`, `scheduling`.
  `timing.load_ms` is now runner spawn to config and test files loaded. Added: `failures[].project`,
  `counts.skipped`, `timing.runner_start_ms`, `timing.client_ms`.

### Unverified / assumptions
- The race itself (runner result before the exit is noticed, `not_accepting_at_run_end`) did not occur in the
  seven real kills; it is covered only by unit tests with a stubbed pool.
- Uncaught page errors in a trace: the `pageError` event shape is assumed (`params.error.error.message`); only
  console events were seen in real traces, and no real failure produced a console error.
- A client that disconnects while its run is queued or running interrupts that run (unit-tested with fiber
  interruption; not tried with a real Ctrl-C). Nothing is stored for such a run.
- Semaphore waiters are assumed to be served in arrival order; only two callers were tried.
- Only Playwright 1.63.0, Linux, one Playwright project (chromium). With several projects a `file:line`
  repro runs the test in all of them.
- An adopted web server, a project without `webServer`, two project paths at once: not run for real here.
- `known` tests come from the latest full run in the store; tests added since are not counted until the next
  full run.
- Timings were taken at load 9 to 27; treat differences under 1 s as noise.

### Not done / next steps
1. `ts-bench`: cold baseline, warm benchmark, CI, README (commands and environment below).
2. A run whose web server died still runs to the end (12 to 18 s above) before the `error` verdict; the Elixir
   engine abandoned at once. A watcher on the pool status could interrupt the runner; the verdict must still
   be decided by `classify` at the end.
3. Run directories under `$COOK_HOME/runs/` (reports, logs, copied traces) and `daemon.log` are never pruned.
4. `cook run` does not start a daemon by itself.
5. Test results of `error` runs are stored (run status `error`); pass-rate queries must join `runs` and skip them.

### Gotchas
- `e2e/reports.spec.ts:13` failed in 3 of 13 full runs with "locator.check: Clicking the checkbox did not
  change its state", all at load above 12. Stage 1 saw the same message once in `activity.spec.ts:22`. It is
  reported as an ordinary failure; whether plain Playwright shows it at this load was not checked.
- The pid in `cook status` is the guard. To simulate a crash kill its child (`pgrep -P <guard>`; for a shell
  command, the last descendant). Killing the guard itself was not tried.
- Changing `--env` between runs restarts the project's web servers (stage 1 behaviour), so always pass the
  same `--env PORT=n` for the fixture. `repro` includes the `--env` flags for that reason.
- `error` verdicts from a pool death keep `counts` as the runner reported them (for example 9 passed, 36
  failed) while `failures` is `[]`.
- `duration_ms` starts when the daemon receives the request; queueing is inside it (`timing.queue_ms`).
- Vitest runs `node:sqlite` and the `.mjs` CLI without extra configuration. `test/cli.test.ts` spawns `node`
  three times (about 0.3 s).
- `HttpRouter.use((router) => Effect.gen(...))` with handlers that close over services keeps the route types
  simple; `router.add` handlers that require services need `Request.From` marker types.
- Effect 4 exports checked in `node_modules` before use: `effect/http` (`HttpRouter.use/serve`,
  `HttpServerResponse.jsonUnsafe/text`, `request.json`), `NodeHttpServer.layer`, `Schema.Struct/Literals/
  NullOr/Array/Union/Record/optionalKey/decodeUnknownSync/decodeUnknownEffect/encodeSync`,
  `Effect.timeoutOption/result/catchCause/forkDetach/forkChild`, `Semaphore.makeUnsafe/withPermit`,
  `Layer.launch`. Docs through Context7 `/websites/effect_website_v4`.

### Interfaces
CLI (`packages/cook/bin/cook.mjs`, or `npm run cook --` in `packages/cook`):
```
cook start [--detach]     foreground, or background: returns when the daemon answers (log $COOK_HOME/daemon.log),
                          exit 2 with the reason and the log tail when it cannot start or is not ready in time
cook run [PATH] [TEST...] [--json] [--env KEY=VALUE]... [--timeout MS] [--workers N] [--config FILE]
                          PATH: first argument if it is a directory, else the current directory.
                          TEST: file or file:line, relative to the Playwright config's directory.
                          exit 0 pass, 1 fail, 2 error. --json prints only the verdict.
cook status [--json]      exit 0, or 2 when no daemon answers
cook stop                 asks the daemon to stop and waits until its pid is gone
env: COOK_PORT (4050), COOK_HOME (~/.cook), COOK_START_TIMEOUT_MS (15000), COOK_RUN_TIMEOUT_MS (900000, daemon),
     COOK_INVOKED_AT_MS (epoch ms of the invocation, for timing.client_ms; default: the CLI's process start)
```
HTTP, `127.0.0.1:$COOK_PORT`:
```
POST /api/runs[?format=text]   waits for the run. 200 with header x-cook-exit-code: 0|1|2; 400 on a bad body
  {"path":"/abs/project","files":["e2e/a.spec.ts:12"],"timeout_ms":10000,"workers":4,
   "env":{"PORT":"43917"},"config":"playwright.config.ts","client_started_ms":1791139000000}
  only "path" is required. Body: the verdict (JSON), or the human summary with format=text.
GET  /api/runs/:id[?format=text]   the stored verdict; 404 {"error":"no run <id>"}
GET  /api/runs/:id?tests=1         {"verdict":{...},"tests":[{run_id,project_path,test_id,file,line,title,
                                    project,status,duration_ms,started_ms}]}
GET  /api/runs[?limit=20&path=/abs/project]   {"runs":[{id,project_path,status,selection_reason,selected,
                                    passed,failed,duration_ms,error_reason,started_at}]} newest first
GET  /api/status   {"schema":"cook.status/1","pid":1,"port":4050,"home":"/home/u/.cook","started_at":"...",
                    "uptime_ms":1,"projects":[{"path":"/abs/project","running":false,"queued":0,
                    "servers":[{"kind":"browser_server","name":"browser server (Playwright 1.63.0)","pid":1,
                    "starts":1,"state":"ready","accepting":true},{"kind":"web_server","name":"webServer[0]",...}]}]}
POST /api/stop     {"stopping":true,"pid":1}; the daemon exits about 0.1 s later
```
Verdict (a real one, shortened):
```json
{"schema":"cook.verdict/1","run_id":"2f9b8fbd-…","status":"fail","path":"/home/ryan/code/cook/fixtures/react_app",
 "duration_ms":11264,
 "timing":{"overhead_ms":887,"tests_ms":76967,"slowest_test_ms":4395,"first_test_ms":814,"queue_ms":0,
           "ready_wait_ms":1,"load_ms":460,"runner_start_ms":813,"client_ms":53},
 "selected":45,"skipped":0,"selection_reason":"all",
 "counts":{"passed":44,"failed":1,"skipped":0,"known":45},
 "failures":[{"test":"e2e/estimate.spec.ts:6","name":"FLAKY: effort estimate appears for a task",
   "project":"chromium","kind":"assertion","step":"expect(await page.getByRole('alert').count(), …).toBe(0)",
   "message":"Error: the estimator answered with an error\n\nexpect(received).toBe(expected) …",
   "trace":"<COOK_HOME>/runs/<id>/artifacts/1-trace.zip","console_errors":[],
   "dom_snapshot":"<COOK_HOME>/runs/<id>/artifacts/1-error-context.md","server_logs":[],
   "repro":"cook run /home/ryan/code/cook/fixtures/react_app --env PORT=43917 e2e/estimate.spec.ts:6",
   "duration_ms":1219}],
 "quarantined":[],"error":null,"seed":null}
```
`timing`: `overhead_ms` = `duration_ms` minus the time between the first test starting and Playwright's
`onEnd`; `tests_ms` = sum of test durations; `first_test_ms` = request received to first test started.
`kind`: `assertion | cap | error`. `error.reason`: `browser_server_down, web_server_down, pool_not_ready,
unknown_project, unknown_tests, test_load_failed, no_tests, runner_crashed, run_timeout, unexpected`.

SQLite, `$COOK_HOME/cook.sqlite` (`PRAGMA user_version` 1):
```sql
CREATE TABLE runs (
  id TEXT PRIMARY KEY, project_path TEXT NOT NULL, status TEXT NOT NULL,   -- pass | fail | error
  selection_reason TEXT NOT NULL, selected INTEGER NOT NULL, passed INTEGER NOT NULL, failed INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL, error_reason TEXT, started_at TEXT NOT NULL,  -- ISO 8601
  verdict TEXT NOT NULL);                                                     -- the verdict as JSON
CREATE INDEX runs_project_started ON runs (project_path, started_at);
CREATE TABLE test_results (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  project_path TEXT NOT NULL,
  test_id TEXT NOT NULL,     -- "<file> › <describe> › <title> [<project>]", stable when lines move
  file TEXT NOT NULL, line INTEGER NOT NULL, title TEXT NOT NULL, project TEXT,
  status TEXT NOT NULL,      -- passed | failed | timed_out | skipped | interrupted
  duration_ms INTEGER NOT NULL, started_ms INTEGER);  -- ms after the run's first test started
CREATE INDEX test_results_run ON test_results (run_id);
CREATE INDEX test_results_test ON test_results (project_path, test_id);
```
TypeScript, from `src/index.ts`: `Coordinator` (service: `run(request): Effect<Verdict>`, `status`),
`makeCoordinator(deps)`, `classify(before, after)`, `testRows(report)`, `buildVerdict(input)`, `Verdict`
(schema), `exitCode`, `summary`, `openStore(file)`, `StoreService`; `WebServer.snapshot(project)`.
