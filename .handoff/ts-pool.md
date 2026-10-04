# ts-pool (TypeScript engine, stage 1: scaffold and warm pool in `packages/cook`)

## 2026-10-04

### Status
COMPLETE

### Done
All paths relative to `packages/cook`. Nothing outside it was changed except this file. Not committed.

- Scaffold: `package.json` (private, exact pins, `package-lock.json`), `tsconfig.json`, `biome.json`,
  `vitest.config.ts`, `.gitignore`. `npm run check` = `tsc --noEmit` + `biome check .` + `vitest run`.
- TypeScript is run by Node 24 itself (type stripping), no build step: `node scripts/x.ts`. The tsconfig enforces
  what that needs (`erasableSyntaxOnly`, `verbatimModuleSyntax`, `.ts` import extensions). Reason: a daemon that
  starts with `node src/...` has nothing to get stale and nothing to build in a container. Cost: when the package
  is published, Node will not strip types under `node_modules`, so publishing needs a build step then; the two
  files that are loaded from outside our own process (`assets/guard.mjs`, `assets/reporter.cjs`) are plain
  JavaScript for that reason already.
- Unit tests: Vitest (runs the `.ts` files directly, 19 tests in about 1.3 s). `@effect/vitest` was tried and
  removed: its `it.effect` runs on a test clock, and these tests wait on real OS processes.
- `assets/guard.mjs`: every OS process Cook starts runs under this guard. The guard leads its own process group
  and holds a pipe to Cook on stdin. On SIGTERM, or when the pipe closes because Cook died (SIGKILL included), it
  lists all descendants (from `/proc`, or `ps` where there is no `/proc`), sends SIGTERM, then SIGKILL after
  `COOK_GUARD_GRACE_MS` (default 2000). Descendants in other process groups are covered. Output of the command
  goes to a log file, so nothing blocks on an unread pipe.
- `src/Supervised.ts`: `spawnGuarded` (scoped process under the guard, through Effect's `ChildProcessSpawner`)
  and `supervise` (start, poll a readiness probe, report ready; restart when a ready process dies; a start that
  never becomes ready is reported with the log tail and tried again only when the next caller asks).
- `src/BrowserServer.ts`: service `BrowserServer`, one `run-server` per Playwright version, started from the
  target project's own `@playwright/test/cli.js` on a free port on 127.0.0.1, new port on every restart, ready
  when the port accepts a TCP connection.
- `src/WebServer.ts`: service `WebServer`, the project's `webServer` entries kept running. Readiness as in
  Playwright (`url`: status 200 to 403; `port`: something listens on loopback; neither: ready once started).
  An entry whose URL already answers before Cook starts it is adopted when it sets `reuseExistingServer`, and is
  an error otherwise. Servers are restarted when the config file's mtime or the project env changes.
- `src/Project.ts`: `resolveProject` (config file, the project's Playwright version and CLI, module format), the
  wrapper config and the parser for what it dumps.
- `src/Runner.ts`: service `Runner`; `src/index.ts`: `PoolLive` layer and `runSuite`.
- `assets/reporter.cjs`: Playwright reporter that records `onBegin`, first `onTestBegin` and `onEnd` times in a
  JSON file. Passed on the command line, so the target project is not changed.
- Scripts: `scripts/run-suite.ts` (the dev command), `scripts/bench.ts` (pool and plain Playwright taking turns),
  `scripts/crash-check.ts` (kills pooled processes and runs again). None of them names the fixture.
- Tests: `test/os.test.ts`, `test/Project.test.ts`, `test/Runner.test.ts`, `test/Supervised.test.ts` (the last
  one starts one-line node programs, no browser and no app).

Versions (`npm ls --depth=0`): effect 4.0.0, @effect/platform-node 4.0.0, typescript 7.0.2, vitest 5.0.3,
@biomejs/biome 2.5.15, @types/node 26.6.4, Node v24.21.0. Effect 4 has the process API in `effect/process`
(`ChildProcess`, `ChildProcessSpawner`); `@effect/platform` (0.97) is the Effect 3 line and is not used.
Effect docs were read through Context7 (`/websites/effect_website_v4`) and every export used was checked in
`node_modules/effect/dist/*.d.ts`.

### OPEN 1, settled: a wrapper config next to the project's config
Cook writes `<configDir>/.cook-playwright.config.mjs` (or `.cjs`, by the same rule Node and Playwright use for
the project's config). It imports the project's config, exports it without `webServer`, and, when
`COOK_WEBSERVER_DUMP` names a file, writes the removed entries there as JSON. Cook learns the entries by running
the project's own `playwright test --list --config <wrapper>` once (nothing is started by `--list`), and passes
the same wrapper to every run, so the runner has no web server to start or to kill. The file is removed when the
pool stops.

Evidence for the choice (all run today, Playwright 1.63.0):
- Import the config with Node directly: works for the fixture, fails for a config with an extensionless import
  (`import { Ports } from './ports'`, where `ports.ts` also has an enum): `ERR_MODULE_NOT_FOUND`. Playwright's
  own loader accepts that config. Rejected.
- Playwright's internal loader: `require('playwright/lib/common/configLoader')` gives
  `ERR_PACKAGE_PATH_NOT_EXPORTED`; in 1.63 the library is bundled (`lib/common/index.js`). Rejected.
- Wrapper outside the project (in Cook's state directory): `--list` on the fixture says `No tests found`,
  because `testDir: './e2e'` resolves against the wrapper's directory. Every config-relative path would need
  rewriting (testDir, outputDir, snapshotDir, globalSetup, tsconfig, per-project dirs, reporter paths).
  Rejected in favour of placing the wrapper in the config's directory, where nothing needs rewriting.
- `reuseExistingServer` alone: `CI=1 npx playwright test e2e/home.spec.ts` against a running server fails with
  `http://127.0.0.1:43545 is already used, make sure that nothing is running on the port/url or set
  reuseExistingServer:true`. Rejected.
- The wrapper, through the engine: fixture (ES module, `url`): passes. A scratch CommonJS project with the
  extensionless import and enum above, `webServer: [{ command: 'node server.js', port, reuseExistingServer: false,
  env }]` and a test asserting `baseURL === 'http://localhost:<port>'`: 1 passed. A scratch project with no
  `webServer`: runs, `webServers: []`.
- One thing the wrapper has to put back: Playwright sets `PLAYWRIGHT_TEST_BASE_URL` from `webServer.port`.
  `WebServer.ensure` returns that as `runnerEnv`, and the runner gets it.
Cost of the choice: one untracked dotfile in the project directory while the pool is up, and it is left behind
if Cook is killed with SIGKILL (harmless, overwritten on the next start).

### OPEN 2, measured: spawning `playwright test` per run costs about 0.65 to 0.75 s
Fixture full suite, 45 tests, 12 workers, this machine, load average 4 to 17 during the runs (another agent was
running Docker builds and the fixture suite).

Pool and plain taking turns, 10 each, same web server, same two reporters (`scripts/bench.ts`):

| | spawn to first test p50 / max | wall p50 / max |
|---|---|---|
| through the pool (`runSuite`, total of the call) | 720 / 760 ms | 10 859 / 11 128 ms |
| plain `playwright test`, dev server already running | 616 / 891 ms | 10 971 / 11 946 ms |

Pool alone, 11 warm runs in a row (`run-suite.ts --repeat 12`): pool wait 0 to 1 ms, spawn to `onBegin`
p50 373 / max 445 ms, spawn to first test p50 652 / max 754 ms, total p50 10 781 / max 11 237 ms.
First run on a cold pool: pool wait 1.4 to 1.6 s (config load with `--list`, Vite start, browser server start),
total 12.6 to 13.1 s. Plain Playwright alone, 9 clean runs: 10.9 to 11.7 s (p50 11.35 s; the fixture handoff
says 10.9 s, and 12.8 s with no server running).

Plainly: on this fixture the warm pool is not faster than plain Playwright with a dev server already running.
The difference (about 0.1 s at p50) is inside the noise. Against plain Playwright with nothing running it saves
about 2 s per run, which is the dev server start. Where the 10.8 s goes: about 0.35 s until Playwright has
loaded the config and the test files, about 0.3 s more until the first worker starts a test, then about 10 s of
tests bounded by the one Vite dev server (see the fixture handoff), 0.07 s to exit. The browser server saves
nothing measurable here: `run-server` launches a fresh Chromium for each worker that connects, as a local
launch would. Keeping the runner process warm could save at most about 0.6 s of 10.8 s on the full suite; on a
single file it is a third of the run (`e2e/settings.spec.ts`: total 1 758 ms, first test at 630 ms).

### Verified
Run from `packages/cook` unless noted. `COOK_HOME` pointed at a scratch directory for all of them.
- `npm run check`: typecheck clean, biome clean, 4 test files, 19 tests passed, 1.3 s.
- `node scripts/run-suite.ts ../../fixtures/react_app --env PORT=<free> --repeat 2 e2e/settings.spec.ts`:
  run 1 cold, 3 passed, pool wait 1 545 ms, total 3 385 ms; run 2 warm, 3 passed, total 1 758 ms.
- `... --repeat 12` (full suite): 12 runs, numbers above. 8 runs 45 passed; 3 runs failed only the `@flaky`
  test; run 3 also failed `e2e/activity.spec.ts:22` ("Clicking the checkbox did not change its state", 2.7 s,
  not a timeout) once in 23 pool runs. Not seen again; cause not found.
- `node scripts/bench.ts ../../fixtures/react_app --env PORT=<free> --runs 10`: table above.
- `... e2e/import.spec.ts:32`: 1 passed (file:line works).
- Scratch project without `webServer`, `--timeout 1000`: the 1.5 s test is reported `timedOut` with "Test
  timeout of 1000ms exceeded"; the other test asserts that Chromium's parent process is `run-server` and passed,
  so the browser does come from the pooled server.
- `node scripts/crash-check.ts ../../fixtures/react_app --env PORT=<free> e2e/settings.spec.ts`: SIGKILL of the
  `run-server` process while idle: restarted (starts 2, new pid), a run issued 300 ms later passed 3/3 with
  102 ms pool wait. SIGKILL of the Vite process: restarted, next run passed 3/3 with 758 ms pool wait.
- SIGKILL of the Cook process while idle: 3.5 s later no guard, `run-server` or Vite process left.
- SIGKILL of the Cook process 5 s into a full run (about 70 Chromium processes alive): 4 s later no guard,
  runner, worker, `run-server`, Vite or Playwright Chromium process left (`pgrep -fc` = 0).
- After every normal exit of the scripts: same check, 0 left, and the wrapper file was gone from the project.
- At the end: `pgrep` finds nothing of mine; `git status --short` shows only `packages/` and `spike/` untracked;
  `~/.cook` was never created.

### Unverified / assumptions
- Only Playwright 1.63.0 and only Linux were run. The guard has a `ps` path for systems without `/proc` and a
  Windows path exists in Effect's spawner; neither was run.
- Two projects with different Playwright versions at once (two browser servers) was not run; the code path is
  the same map keyed by version.
- `webServer` options not honoured: `wait` (stdout/stderr patterns), `gracefulShutdown`, `ignoreHTTPSErrors`,
  `stdout`/`stderr` piping. An entry using `wait` without url/port is treated as ready at once.
- A browser server or web server dying during a run was not tested here (next stage); the runner then simply
  exits non-zero and `runSuite` returns that exit code and whatever report exists.
- An adopted server (already running, reuse allowed) is not owned: if it dies Cook does not restart it. The
  adoption path was not run against a real project.
- The config change check looks only at the config file's mtime, not at files it imports.
- Concurrent `runSuite` calls for one project were not run; nothing queues them yet (next stage).
- Timings are from a loaded machine; treat differences under 0.5 s as noise.

### Not done / next steps
1. `ts-runs`: queue per project path around `Runner.run`; classify `exitCode` not in {0, 1} or `report === null`
   as `error` (compare `pool.browserServer.pid/starts` before and after to tell a pool crash); verdict; SQLite;
   HTTP API; CLI.
2. Decide whether the 0.6 to 0.7 s runner start is worth a warm runner. On the fixture's full suite it is 6 %.
3. The JSON report's error messages contain ANSI colour codes; strip them in the verdict (or set `FORCE_COLOR=0`
   in the runner env and check that nothing else changes).
4. Run directories under `$COOK_HOME/runs/<id>` are never deleted; logs under `$COOK_HOME/logs` only grow.

### Gotchas
- I killed a process that was not mine. After the plain timing series I stopped my dev server with
  `kill $(pgrep -f "react_app/node_modules/.bin/[v]ite")`, which also matched pid 2602170, a Vite dev server
  that another agent's `playwright test --workers=4 --reporter=line` loop had started seconds earlier. That one
  run of theirs will have failed; their loop was seen starting the next run. Kill by pid, never by pattern,
  while other agents use the same fixture.
- `pgrep -f pattern` matches the shell that runs it when the pattern text appears in the command line; counts
  were off by one until the patterns were written as `[g]uard.mjs`.
- Playwright starts Chromium detached (own session), so killing a process group does not reach it. It does
  exit when its `run-server` dies; the guard also walks the whole tree to be sure.
- Effect's spawner starts children detached and signals the process group when the scope closes, but with no
  `forceKillAfter` it then waits for the exit without limit. `spawnGuarded` sets 3 seconds.
- `--reporter=` on the command line replaces the project's reporters (no HTML report is produced or opened).
  With no reporter printing to stdout Playwright adds its own terminal reporter; that output is in
  `output.log`.
- The fixture reads its port from `PORT` in both the config and the Vite config, so the same `--env PORT=n`
  must reach the config load, the server and the runner. `ProjectSpec.env` does that. Without it the fixture
  uses 4310, which may be taken.
- The guard reports a command killed by a signal as exit code 128.
- Biome 2.5 warns that `linter.rules.recommended` is deprecated; the config leaves the linter at its default.

### Interfaces
Run the fixture's suite through the pool (from `packages/cook`; pick any free port, or leave `--env` out to use
the fixture's 4310):
```
npm run suite -- ../../fixtures/react_app --env PORT=43117 [--repeat N] [--workers N] [--timeout MS] \
    [--report] [--hold] [file or file:line ...] [-- extra playwright args]
```
Per run it prints one line of counts and timings on stderr; `--report` prints the last `RunResult` as JSON on
stdout. `node scripts/bench.ts <project> [--env K=V] [--runs N]` and `node scripts/crash-check.ts <project>
[--env K=V] [file ...]` are the other two. State goes to `$COOK_HOME` (default `~/.cook`): `logs/`, `tmp/`,
`runs/<runId>/{report.json,events.json,output.log}`.

From `src/index.ts`:
```ts
const PoolLive: Layer.Layer<Runner | BrowserServer | WebServer>   // closing its scope stops everything
const runSuite: (spec: ProjectSpec, options?: RunOptions) => Effect.Effect<RunResult, CookError, Runner>
const resolveProject: (spec: ProjectSpec) => Effect.Effect<Project, ProjectError>

interface ProjectSpec { path: string; config?: string; env?: Record<string, string> }
interface RunOptions { files?: string[]; testTimeoutMs?: number /* 10000 */; workers?: number | string; extraArgs?: string[] }
interface RunResult {
  runId: string; runDir: string
  exitCode: number                    // of `playwright test`: 0 passed, 1 failures, other = not a test result
  report: PlaywrightReport | null     // Playwright's JSON report, untouched
  timings: { poolWaitMs: number; spawnToBeginMs: number | null; spawnToFirstTestMs: number | null;
             spawnToEndMs: number | null; spawnToExitMs: number; totalMs: number }
  tests: number | null; workers: number | null; command: string[]
  pool: { cold: boolean; browserServer: Ready<BrowserServerInfo>; webServers: Array<Ready<WebServerInfo> | { info: WebServerInfo }> }
}
interface Ready<Info> { info: Info; pid: number /* the guard */; startMs: number; starts: number }
type CookError = ProjectError | PoolError | RunError   // tagged: { path, reason } | { server, reason, logTail? } | { reason, logFile? }

class Runner        { run(spec: ProjectSpec, options?: RunOptions): Effect<RunResult, CookError> }
class BrowserServer { ensure(project: Project): Effect<{ ready: Ready<BrowserServerInfo>; cold: boolean }, PoolError>
                      status: Effect<Array<{ playwrightVersion: string; status: Status<BrowserServerInfo> }>> }
class WebServer     { ensure(project: Project): Effect<WebServers, PoolError>      // { config, runnerEnv, servers, cold }
                      entries(project: Project): Effect<WebServerEntry[], PoolError> }
```
The runner command is `node <project>/node_modules/@playwright/test/cli.js test --config <wrapper> --retries=0
--timeout=<cap> --reporter=<assets/reporter.cjs>,json [--workers=N] [extra args] [files]`, run in the config's
directory with `PW_TEST_CONNECT_WS_ENDPOINT`, `PLAYWRIGHT_JSON_OUTPUT_NAME`, `COOK_EVENTS_FILE`, the project env
and `runnerEnv`.
