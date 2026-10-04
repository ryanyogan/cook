# speed-profile (where the 10 s go on `fixtures/react_app`, and which levers cut them)

## 2026-10-04

### Status
COMPLETE

### Done
Measurement only. No product code, nothing in `fixtures/react_app`, `packages/`, `spike/` or the Elixir code was
touched. Everything is in `/tmp/claude-1000/cook-speed-profile/` (not in the repo, will not survive a reboot):
- `app/`: copy of the fixture (own `data/`, own `test-results/`, own `dist/` from `vite build`), plus two wrapper
  configs, `pw.slowfirst.config.ts` and `pw.multi.config.ts` (the kind of file a runner would generate).
- `bench.mjs`: runs one `npx playwright test`, records wall time, results from the JSON report, CPU per process
  class (sampled from `/proc` every 100 ms) and server CPU per thread. `agg.mjs`, `timeline.mjs`: summaries.
- `step-reporter.mjs` + `steps-agg.mjs`: self time per Playwright step. `probe.mjs`: latency of `/api/health`
  during a run. `pageload.mjs`: requests, bytes and time to hydration of one page. `browser-server.mjs`: one shared
  Chromium through `chromium.launchServer()`.
- `results.jsonl`: every recorded run (about 190), with per-test start, duration and worker.

### Answer in short
The single dev server is not the bottleneck. Baseline here: 11.0 s p50 (12 runs, 10.5 to 11.8 s).
1. About 3.5 s of the 11 s is one worker running a `@slow` test alone while the machine is idle. Playwright
   starts tests in file order, `workflow.spec.ts` is last, so the 4.3 s test starts at about 6.2 s.
2. In the 6.6 s before that, half of all test time (854 of 1 665 ms per test) is waiting for hydration, which in
   dev mode means 115 requests and 1.9 MB of unbundled JavaScript per page in a fresh browser context. The
   production build needs 12 requests and 111 kB.
3. Tracing (`trace: 'retain-on-failure'` records every test) costs a third of all CPU.
4. The machine has 12 physical cores. With 12 workers the run uses 13 to 16 CPU-seconds per second, so tests
   slow each other down: total test time is 38 s with 1 worker, 76 s with 12, 152 s with 24.

### Levers (wall time p50; baseline 10.9 s in the brief, 11.0 s measured here)
"Other failures" = failures that are not the `@flaky` test, summed over the runs. Flaky failures were 0 to 2 per
series, as designed, and are not listed.

| Lever | Wall p50 (range), runs | Other failures | Can a runner apply it from outside? |
|---|---|---|---|
| Baseline: dev server, 12 workers | 11.0 s (10.5 to 11.8), 12 | 0 | |
| Workers 4 / 6 / 8 / 16 / 24 (dev) | 14.7 / 12.2 / 11.4 / 11.4 / 12.0 s, 3 each | 0 | Yes: `--workers=N`. No gain alone; 12 is already the best. |
| Tracing off | 9.7 s (9.5 to 9.8), 3 | 0 | Yes: `--trace=off`. Failed tests then have no trace; rerunning only the failures with tracing on was not measured. |
| Slow tests first | 8.2 s (8.0 to 8.3), 3 | 0 | Yes: wrapper config that splits each project in two with `grep` / `grepInvert`. Needs durations from an earlier run. Changes project names (see Gotchas). |
| Production build (`vite build` + `vite preview`) | 6.8 s (6.65 to 7.2), 9; first series 8.0 s (7.1 to 9.5), 3, under heavier load | 0 | Partly: the runner can start the processes, but the build and serve commands are project knowledge (one setting, no test changes). Build took 1.65 s. Tests then run against production code, not dev code. |
| Production + tracing off | 6.2 s (6.2 to 6.3), 5 | 0 | as above |
| Production + slow first | 5.8 s (5.5 to 5.9), 4 | 0 | as above |
| Dev + slow first + tracing off, 8 / 12 / 16 workers | 7.6 / 6.8 / 7.7 s, 5 each | 0 | Yes, fully from outside. |
| Production + slow first + tracing off, 6 / 8 / 10 / 12 / 16 / 24 workers | 5.6 / **4.5** / 4.8 / 5.0 / 5.6 / 6.5 s; 3 to 6 each (8 workers: 4.45 to 4.66 over 5, and 4.60 to 4.72 over 3 earlier) | 0 | as production build |
| 4 server instances, one shared SQLite file | dev 11.7 s, production 7.3 s, 3 each | 5 in 6 runs (`database is locked` in the server logs) | No: breaks this app. |
| 4 server instances, one database each | dev 10.75 s against 11.0 s interleaved; production 6.8 against 6.8; with slow first + tracing off: dev 6.6 against 6.8, production 5.0 against 5.0; 3 each | 0 | Partly: wrapper config sets `baseURL` from `TEST_PARALLEL_INDEX` (works, load was spread evenly), the runner starts N servers, but a database per instance needs the project (`DATABASE_PATH` here). No gain. |
| One shared browser instead of one per worker | production 6.75 s against 6.75 s interleaved; with slow first + tracing off 5.1 against 5.0; 3 each | 2 in 6 runs (`activity.spec.ts:22`, both with tracing on) | Yes: `PW_TEST_CONNECT_WS_ENDPOINT`. No gain. |
| Floor: only the three `@slow` tests | production, tracing off: 4.3 s (4.2 to 4.4), 3. Dev: 5.0 s (4.75 to 5.1), 6 | 0 | Lower needs changes to the tests or the app. |

Best combination actually run: production build, slow tests first, `--trace=off`, `--workers=8`: 4.50 s p50,
2.4 times faster than the baseline and 0.2 s above the floor. Without the production build (nothing needed from
the project): 6.8 s.

### Verified
All from `/tmp/claude-1000/cook-speed-profile`, servers on ports 4520 (dev) and 4521 (production), extra
instances on 4522 to 4527. Load average before each run is in `results.jsonl`; it was 3 to 27 over the session
because another agent ran the same suite on its own server.
Command shape: `node bench.mjs --cwd app --server <pid> --env PORT=4520 --out results.jsonl -- --reporter=list,json [flags]`,
summary with `node agg.mjs`.

Where the baseline's time goes (12 runs, dev, 12 workers):
- Phases: first test starts at 0.8 s; the last test that is not `@slow` ends at about 7.4 s; the last 3.5 s (p50)
  is the slow test alone (CPU of the whole tree in those seconds: 2.3, 1.0, 0.1, 0.2 CPU-s); exit 0.07 s.
- CPU per run: Chromium 68.5 CPU-s (renderers 36.5, browser processes 15.5, network and other utility 10.7,
  GPU 5.4), Playwright workers 28.9, runner 1.0, dev server 5.5 (main thread 4.6). In the busy seconds the server
  uses 0.75 to 1.15 CPU-s per second and the runner tree 13 to 16.
- Per test (`step-reporter.mjs`, mean 1 665 ms): hydration wait (`toBeAttached` in `visit`) 854 ms, `page.goto`
  199, other assertions about 350, clicks 72, new page 41, API calls including signup 30, browser launch 22.
  Same on production: mean 783 ms, hydration wait 43 ms, `page.goto` 177.
- With 1 worker (dev, 39.4 s wall): mean test 849 ms, p50 510 ms; on a 10-test subset 361 of 604 ms per test was
  the hydration wait.
- One page in a fresh context, idle server (`pageload.mjs`, median of 8): dev 115 requests, 1 922 kB, hydrated
  after 344 ms; production 12 requests, 111 kB, hydrated after 150 ms. Document TTFB 3 to 4 ms in both.
- Server queueing during a 12-worker run (`probe.mjs`, 3 runs dev, 1 production): dev p50 5.5 to 9.4 ms,
  p90 49 to 74 ms, p99 220 to 284 ms, max 351 ms; production p50 3.5, p90 7.4, p99 15.6, max 89 ms. Idle: 2 to
  3 ms.
- Tracing off: CPU of the tree falls from 99 to 66 CPU-s (workers 28.9 to 19.7, Chromium 68.5 to 45.0).
- Total test time by workers (dev): 1: 38 s, 4: 43 s, 6: 49 s, 8: 57 s, 12: 76 s, 16: 101 s, 24: 152 s.
- `--test-list` filters tests but does not change their order (tried with 1 worker).
- `vite preview --port 4521 --host 127.0.0.1 --strictPort` serves the server-rendered production build; all 45
  tests pass against it.
- End state: all eight servers and the browser server stopped by pid, none of the pid files' processes alive,
  nothing listening on 4520 to 4527. `fixtures/react_app` unchanged.

### Unverified / assumptions
- That the hydration wait grows from 344 ms to 854 ms under 12 workers because of CPU contention on the machine
  and not the server: inferred from four servers giving no gain and from test time growing with workers. Not
  proven directly.
- The other agent's runs overlapped some of mine. Three baseline runs taken during those (14.8, 15.2, 16.3 s) are
  outliers and are not in the baseline p50; every comparison in the table was run interleaved with its control.
- One fixture, one machine. The share of each lever will differ for other apps; a project without slow tests
  gains nothing from ordering, a project that already serves a production build gains nothing from that row.
- Rerunning failed tests with tracing on (to make up for `--trace=off`) was not run.
- Splitting the run into two concurrent `playwright test` invocations instead of the two-project wrapper was not
  run.
- The 2 failures of `activity.spec.ts:22` with a shared browser: cause not looked for. `ts-pool.md` saw the same
  test fail once in 23 runs without a shared browser.
- CPU numbers miss whatever a process used in its last 100 ms. In runs with a `--workers` flag the runner's 1 s
  of CPU is counted under workers (the classifier matches the word).

### Not done / next steps
1. Slow tests first is the largest lever that needs nothing from the project (11.0 to 8.2 s). Decide how Cook
   does it without renaming projects; `test-level-scheduling.md` was not read by this stage.
2. `--trace=off` on the first pass and a traced rerun of failures: measure the rerun cost, then decide.
3. A production-server mode as a per-project setting (build command, serve command). Largest single lever
   (11.0 to 6.8 s) but it changes what is tested.
4. Pick the worker count per project from measurement: 8 was best on production, 12 on dev; above the
   physical core count it only got slower.
5. Do not build several server instances or a shared browser for speed: neither gained anything here.
6. After 1 to 3 the run is at 4.5 s against a floor of 4.3 s; the 0.65 s runner start is then the next item.

### Gotchas
- The slow-first wrapper names the second project `chromium~rest`. That name shows in reports, in `--project`
  filters and in snapshot paths that use `{projectName}`. Projects with `dependencies` were not tried.
- After a failed test Playwright starts a new worker, so a run with the flaky failure has 13 workers.
- Several instances on one SQLite file fail with `database is locked`; the app sets no busy timeout.
- With slow tests first on the dev server the slow tests themselves take 5.2 to 6.8 s instead of 4.2 s, because
  they now overlap the busy phase. On production with tracing off the longest takes 3.4 to 3.6 s with 8 workers
  and 3.8 to 4.1 s with 12.
- A config file is loaded again in each worker with `TEST_PARALLEL_INDEX` set, which is what makes a per-worker
  `baseURL` in a wrapper config work.
- `chromium.launchServer()` gives every connection the same browser; `playwright run-server` launches one per
  connection.
- The database of a per-instance server is only created on the first request that needs it.

### Interfaces
None for later stages. To repeat a measurement: start a server from `app/` (`PORT=4520 node
node_modules/vite/bin/vite.js dev`, or `npx vite build` then `node node_modules/vite/bin/vite.js preview --port
4521 --host 127.0.0.1 --strictPort`), then
`node bench.mjs --cwd app --server <pid> --env PORT=<port> --env SLOWFIRST=1 --out results.jsonl -- --reporter=list,json -c pw.multi.config.ts --trace=off --workers=8`.
`pw.multi.config.ts` reads `SLOWFIRST` (split projects on `@slow`) and `COOK_PORTS` (comma-separated ports, one
server per worker modulo the list).
