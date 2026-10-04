# ts-order (TypeScript engine: longest-first scheduling and the tracing policy)

## 2026-10-04

### Status
COMPLETE

### Done
All paths relative to `packages/cook`. Nothing outside it was changed except this file. Not committed. The
Elixir code, `fixtures/` and `spike/` were not touched.

- `assets/order.cjs` (new): `applyOrder(config, rootSuite, durations)`. Reorders Playwright's suite tree in place
  so the slowest work is queued first. Plain CommonJS, loaded by the reporter.
- `assets/reporter.cjs`: gained a `preprocess` hook that reads `COOK_ORDER_FILE` (`{ "<test id>": ms }`), calls
  `applyOrder`, and records what it did under `order` in `events.json`. Any exception there is caught and
  recorded; it cannot fail the project's run.
- `src/Diagnostic.ts` (new, pure): the two policies and their defaults, `firstRunTrace`, `rerunSelection`,
  `rerunOutcomes`, `mergeArtifacts`.
- `src/Runner.ts`: `RunOptions.trace` (`--trace=on|off`), `RunOptions.durations` (written to
  `<runDir>/order.json`), `RunResult.order`.
- `src/Store.ts`: `recentDurations(projectPath, perTest = 5)`. No schema change (`user_version` still 1).
- `src/Coordinator.ts`: applies both policies, runs the diagnostic rerun, merges its artifacts.
  `collect(rows, runDir, label?)` gained the label (rerun files are `<n>-rerun-trace.zip`).
- `src/Verdict.ts`: additive fields (see Interfaces); the summary text names the rerun.
- `src/Api.ts`, `bin/cook.mjs`: `trace` and `order` in the request body, `--trace` and `--order` on the CLI.
- `scripts/bench-policies.mjs` (new): the four configurations taking turns through `cook run --json`.
- Tests (no browser, no app): `test/Order.test.ts`, `test/Diagnostic.test.ts`, four new tests in
  `test/Coordinator.test.ts`, one each in `test/Store.test.ts` and `test/Verdict.test.ts`. The existing queueing
  test now passes `trace: "project"` because its stub runner cannot serve a rerun.
- No Effect API was used that the package did not already use, so no Effect docs were fetched.

### How Playwright 1.63 orders work (read in `fixtures/react_app/node_modules/playwright/lib/runner/index.js`)
- `createRootSuite` builds root -> project suites -> file suites -> describes -> tests; files in the order
  the directory walk returns them, tests in declaration order.
- `createTestGroups(projectSuite, workers)` walks `projectSuite.allTests()` in that order and cuts groups: per
  worker hash, per file, one "general" group (tests not in parallel mode), one group per test in parallel mode
  (or per outermost serial/default describe inside it), and parallel tests under a `beforeAll`/`afterAll` hook
  in chunks of `ceil(n / workers)`. Groups stay clustered by file.
- `createPhasesTask` puts projects into phases by `dependencies`/`teardown`; the dispatcher takes groups from
  the front of the queue. Nothing re-sorts tests after `createRootSuite`.
- `--test-list` filters only (speed-profile checked). `onBegin` runs after the groups are cut (task order:
  phases, then report begin), so a reporter cannot reorder there.
- `Reporter.preprocess({ config, suite, testRun })` is a public hook (`types/testReporter.d.ts`), called at the
  end of `createRootSuite`, before the groups are cut, with the live root suite. Its public `TestRun` can only
  skip/exclude/mark tests; it has no reorder call.

### The ordering mechanism, and how safe it is
Cook's reporter (already on the command line, so nothing in the project changes) permutes the private
`Suite._entries` arrays inside `preprocess`. No project is split or renamed, no test is filtered, so project
names, test ids, titles, snapshot paths and `dependencies`/setup projects are what they were.
What is moved, and only this:
- the files of a project, by the weight of their largest group;
- the children of a suite that is in parallel mode, not inside a serial/default-mode suite and with no
  `beforeAll`/`afterAll` on its path (each test there is already a group of its own).
Never moved: anything across suites, files or projects; tests that run one after another in one worker (serial
files, files of a project that is not `fullyParallel`, files with a top-level `beforeAll`); projects that
another project names in `dependencies` or `teardown`. With `workers: 1` nothing is reordered at all, because
then queue order is execution order and Playwright documents alphabetical file order for that case.
Because groups stay clustered by file, the result is "files by their slowest group, then slowest first inside
a file", not one global sort. On the fixture that is enough (see numbers).

Limits, plainly:
1. It depends on one public hook and three private fields (`_entries`, `_parallelMode`, `_hooks`). Before
   touching anything `applyOrder` checks the whole tree has that shape (`_entries` is exactly `suites` +
   `tests`, etc.); if not, it does nothing and the verdict says `scheduling.applied: false` with the reason.
   Only 1.63.0 was run. A Playwright without `preprocess` never calls the hook: runs are then in project order
   and `scheduling.reason` says so. Which release added `preprocess` was not looked up.
2. It cannot change what a test does, but it changes which tests overlap in time. A suite whose tests
   interfere through shared server state can therefore fail differently, exactly as it can with a different
   worker count. On the fixture the slow tests take 5.2 to 8.2 s instead of 4.3 s when started in the busy
   phase (cap is 10 s); see Gotchas.
I left it on by default: it moves only groups Playwright already runs in no promised order, and it is off
per run with `--order project`.

Tests with no recorded duration are assumed to be as slow as the slowest known test of the run, and keep their
place among equals. Reason: a new test may be the slowest one; starting it early costs nothing if it is quick,
starting it last costs its whole duration with the other workers idle. A test that has only ever been skipped
by its file counts with the duration of the skip (otherwise it would pin its file to the front for ever; this
happened on the scratch project). Durations are the median of each test's last 5 finished results in runs that
were not errors.

### The tracing policy
`trace`: `on-failure-rerun` (default) | `project` | `off`.
- `on-failure-rerun`: the run gets `--trace=off`. If the verdict is `fail`, the failed tests (at most 20,
  `COOK_RERUN_LIMIT`) are run once more as `file:line` filters with `--project=<name>` for the projects they
  failed in and `--trace=on`. Setup projects run again with them (Playwright does that itself).
- The verdict is decided before the rerun and is not touched by it: status, counts and the one failure entry
  come from the first run; only the first run's rows are stored. The rerun contributes
  `failures[].diagnostic_rerun` (`passed | failed | not_run`), the trace, `console_errors` read from that trace
  and, only if the first run left none, the error context. `timing.diagnostic_rerun_ms` is its wall time; it is
  inside `duration_ms` and in neither `overhead_ms` nor `tests_ms`.
- No rerun when the verdict is `pass` or `error`, or under `project` / `off`. A rerun that breaks, times out or
  leaves no report gives `not_run`, and the verdict is still the first run's.
- When `diagnostic_rerun` is `passed`, `trace` is the trace of the passing rerun, not of the failure (the
  summary text says "trace (of the passing rerun)"). Decide later whether that should be null instead.

### Verified
2026-10-04, this machine, `COOK_HOME=/tmp/claude-1000/cook-ts-order/home`, `COOK_PORT=43055`, fixture on
`PORT=43917`, scratch project on `PORT=43871`.
- `npm run check`: typecheck clean, biome clean, 12 test files, 64 tests passed, 1.3 s.
- Fixture, `node scripts/bench-policies.mjs ../../fixtures/react_app --env PORT=43917 --runs 8 --warmup 3`,
  45 tests, 12 workers, warm pool, 8 runs per configuration taking turns, wall = `cook run --json` start to
  exit. Load average (1 min) before each run was 7.4 to 19.0; it was 3.6 before the series started, so the
  load is this benchmark's own.

  | configuration | wall p50 | min | max | p50 / max without the rerun | failing runs | failed tests | flaky / other |
  |---|---|---|---|---|---|---|---|
  | (a) `--order project --trace project` (behaviour before this stage) | 10.65 s | 10.40 | 11.44 | same | 6 of 8 | 7 | 3 / 4 |
  | (b) `--order longest-first --trace project` | 8.18 s | 7.69 | 9.36 | same | 3 of 8 | 3 | 1 / 2 |
  | (c) `--order project --trace on-failure-rerun` | 9.65 s | 9.22 | 11.88 | 9.45 / 10.56 | 2 of 8 | 2 | 2 / 0 |
  | (d) both (the defaults) | 6.69 s | 6.29 | 7.92 | 6.60 / 7.57 | 2 of 8 | 2 | 2 / 0 |

  Profile's reference: 11.0, 8.2, 9.7 s, and 6.8 s for its own slow-first + trace-off experiment.
  "Other" failures are all `locator.check: Clicking the checkbox did not change its state`
  (`reports.spec.ts:13` three times and `activity.spec.ts:22` once in (a), `task-list.spec.ts:74` twice in
  (b)): 6 in the 16 runs with the project's tracing on, 0 in the 16 runs with tracing off. Earlier handoffs saw
  the same message under load. No `error` verdicts.
- Cost of the diagnostic rerun on the fixture: 4 reruns, 1 199 / 1 256 / 1 320 / 1 432 ms, each for the one
  `@flaky` test, each `diagnostic_rerun: "passed"`. About 0.6 s of that is the runner start.
- A failing run under the defaults (fixture, run `fda762d5`): `status "fail"`, `duration_ms 7641`,
  `counts {passed 44, failed 1}`, `timing.diagnostic_rerun_ms 1432`, `overhead_ms 671`; one failure entry
  `e2e/estimate.spec.ts:6`, `diagnostic_rerun "passed"`, `trace .../artifacts/1-rerun-trace.zip` (70 416
  bytes), `dom_snapshot .../artifacts/1-error-context.md` (from the first run), `console_errors []`. Stored
  rows of that run: 1 failed, 44 passed.
- Deterministic failure (scratch project, `--env SCRATCH_FAIL=1`): exit 1, `diagnostic_rerun "failed"`,
  `trace .../1-rerun-trace.zip`, `console_errors ["scratch console error"]` (read from the rerun's trace),
  `diagnostic_rerun_ms 1796` (the setup project ran again), counts 11 passed 1 failed. With `--trace project`
  the same test: one run, trace `1-trace.zip` from the project's own `retain-on-failure`,
  `diagnostic_rerun "not_run"`, `diagnostic_rerun_ms null`.
- Scratch project `/tmp/claude-1000/cook-ts-order/scratch` (Playwright 1.63.0 through a symlink to the
  fixture's `node_modules`; `fullyParallel`, 4 workers, a `setup` project that writes a storage state, a
  `chromium` project depending on it, two `toHaveScreenshot` with names, one without, one
  `toMatchAriaSnapshot` file, a serial file whose second test needs the first, one skipped test). Baselines
  written once by plain `playwright test --update-snapshots`. Then through `cook run --json`, 3 runs with
  `--order project` and 3 with longest-first applied (`scheduling.applied true`): every run 11 passed, 1
  skipped; the sorted list of (test id, project, status) is byte-identical across all six (`cmp`); project
  names stay `setup` and `chromium`; `sha256sum` of the four snapshot files is unchanged after all runs and no
  new snapshot file appeared; the setup test always started first; the serial pair passed every time.
  Start of the 2.6 s test, in ms after the first test: 682, 716, 722 in project order; 544 and 640 in the
  first two ordered runs (before skipped tests counted as known, its file tied with another and stayed
  second); 367, 434, 457 in the three ordered runs after that fix (its file first). Run wall time showed no
  difference on this small suite (3.9 to 4.4 s either way, two of the runs on a cold pool).
- `--trace sometimes`: exit 2 with the allowed values. The same over HTTP: 400. `{"trace":"off",
  "order":"project"}` over HTTP: pass, verdict echoes both.
- End state: `cook stop` done; daemon, browser server and both web server guards gone (checked by pid);
  nothing listening on 43055, 43871, 43917; no `.cook-playwright.config.*` left in either project;
  `git status` shows nothing under `fixtures/`; the Monitor I started was stopped.

### Unverified / assumptions
- Only Playwright 1.63.0 on Linux. Older versions (no `preprocess`) and newer ones (private fields may move)
  were not run; the guard for a changed tree shape is covered by unit tests with stand-in suites only.
- Projects with several browser projects, `repeatEach`, sharding (`--shard` is applied after `preprocess`),
  `test.describe.parallel` inside a non-parallel project, and `beforeAll` chunks were not run for real; the
  last three are covered by unit tests of the ordering decision only.
- Whether the "checkbox did not change its state" failures depend on tracing or only on the extra CPU it uses
  was not investigated. 16 runs per side is small.
- A rerun during which a pooled server dies is treated as `not_run`; the death is not reported in that verdict
  (the next run's settle step handles it). Not run for real.
- The rerun limit (20) was only unit tested with limit 0.
- A missing-baseline `toHaveScreenshot` failure writes the baseline in the first run, so its rerun passes and
  the entry says `passed`. Reasoned, not run.
- Explicit `file:line` runs are ordered too (same code path); only full runs were timed.

### Not done / next steps
1. Next stage (production build serving) should measure against (d): 6.7 s p50 here.
2. Decide whether `trace` should be null when the rerun passed.
3. Worker count: with ordering the slow tests take 5.2 to 8.2 s (cap 10 s) because they overlap the busy
   phase; the profile found 8 workers better than 12 once tracing is off. Not in scope here.
4. A flake ledger can now be built from `failures[].diagnostic_rerun`; it is only in the verdict JSON, not in
   a column.
5. Carried over: run directories are never pruned (reruns add a second directory per failing run).

### Gotchas
- With ordering and the project's tracing on, the fixture's slowest test ran 6.7 to 8.2 s (7 of 8 runs above
  6.9 s) against a 10 s cap. With tracing off it was 5.2 to 5.7 s. On a slower machine (b) could hit the cap.
- The diagnostic rerun wipes the project's output directory, like every Playwright run. The first run's files
  are copied to `<runDir>/artifacts` before it starts; the rerun has its own run directory under
  `$COOK_HOME/runs/` and no row in `runs`.
- The daemon runs the code it started with: restart it after editing `src/` (the reporter and `order.cjs`
  are loaded fresh by every runner).
- `scheduling.unknown > 0` on every run means some test is never recorded (for example it is interrupted
  every time); such a test keeps its file near the front.
- Test ids in `order.cjs` must stay identical to `Report.ts` (`testId`): file relative to the config
  directory, every describe title including empty ones, ` [project]` when named.
- `.handoff/NEXT.md` shows as modified in `git status`; not by this stage.

### Interfaces
CLI: `cook run ... [--trace on-failure-rerun|project|off] [--order longest-first|project]` (defaults first).
HTTP `POST /api/runs`: body fields `"trace"` and `"order"` with the same values; anything else is a 400.
Daemon env: `COOK_RERUN_LIMIT` (20).
Verdict, additive (all optional when decoding, so stored older verdicts still decode):
```json
{"trace":"on-failure-rerun",
 "scheduling":{"order":"longest-first","applied":true,"reason":null,"estimated":45,"unknown":0},
 "timing":{"...":0,"diagnostic_rerun_ms":1432},
 "failures":[{"...":"...","diagnostic_rerun":"passed"}]}
```
`scheduling.reason` is a sentence when `applied` is false under `longest-first` (no durations yet, one worker,
unknown tree shape, hook not called). `diagnostic_rerun_ms` is null when no rerun was made.
TypeScript: `RunRequest.trace / .order`; `RunOptions.trace?: "on" | "off"`, `RunOptions.durations?:
ReadonlyMap<string, number>`; `RunResult.order: OrderOutcome | null` (`{applied, reason, estimated, unknown,
moved}`); `Store.recentDurations(path, perTest?)`; `CoordinatorDeps.rerunLimit`, `collect(rows, runDir,
label?)`; from `src/Diagnostic.ts`: `TracePolicy`, `OrderPolicy`, `RerunOutcome`, `rerunSelection`,
`rerunOutcomes`, `mergeArtifacts`, `firstRunTrace`.
Files per run: `<runDir>/order.json` (durations handed to the reporter), `events.json` gains `order`.
Benchmark: `node scripts/bench-policies.mjs <project> [--env K=V]... [--runs 8] [--warmup 2] [--out f.jsonl]`
against a running daemon. Raw rows of this stage: `/tmp/claude-1000/cook-ts-order/bench1.jsonl` (not in the
repo).
