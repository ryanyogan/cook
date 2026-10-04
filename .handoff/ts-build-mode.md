# ts-build-mode (TypeScript engine: opt-in build serving, kept fresh by the daemon)

## 2026-10-04

### Status
INCOMPLETE. Stopped early on the orchestrator's instruction (work is moving to another machine). The code is
complete as designed and `npm run check` passes; the benchmark, the edit-cost series and the stale-build check
were run. Not run for real: a failing build and the run after fixing it, a bad config file, plain
`npx playwright test` in the fixture (only `--list`). See "Not done".

### Done
Paths relative to `packages/cook` unless they start with `fixtures/`. Nothing committed. Elixir code and `spike/`
untouched.

- `src/Build.ts` (new, no Effect runtime, synchronous `node:fs`):
  - `CookConfig` (Effect Schema), `parseCookConfig(text)`, `loadCookConfig(root)` (null when the project has no
    file), `ConfigProblem` (error with a message for the developer).
  - `planServing(entries, config, requested)`: pure; per `webServer` entry `dev` (the entry's command) or
    `build` (the file's serve command); `workers` for the mode; a `key` that identifies what is running.
  - Freshness: `scanFiles(root, paths, ignore)` (stat only), `stampInputs`, `stampOutputs`, `scanOutputs`,
    `decideFreshness(record, key, inputs, outputs, hashOf, nowMs)` (pure), `buildKey`, `parseBuildRecord`.
- `src/WebServer.ts`: `ensure(project, { serve? })` now learns the entries (cached per config mtime and env),
  reads the project's file, checks freshness, and when the mode changed or a build is stale: stops the project's
  servers, runs the build command(s) under the guard, starts the servers and waits until ready. Returns
  `serving` (requested, checkMs, buildMs, restartMs, per-server mode and rebuild reason) and `workers`.
  `WebServerInfo.mode`; `snapshot` carries `mode` and the command (`detail`). The one global lock became one
  lock per project config, so a long build of one project does not block another. Build records:
  in memory, and in `$COOK_HOME/builds/<id>-<index>.json` when the file declares `outputs`. Build output:
  `$COOK_HOME/logs/build-<id>-<index>.log` (truncated per build).
- `src/errors.ts`: `BuildError { kind: "config" | "build", server, reason, logTail?, logFile?, checkMs, buildMs }`,
  part of `CookError`.
- `src/Runner.ts`: `RunOptions.serve`; workers = the caller's, else the file's for the mode; `RunResult.serving`.
- `src/Coordinator.ts`: `RunRequest.serve` (also passed to the diagnostic rerun and written into `repro`);
  `BuildError` -> `error` verdict `build_failed` (message: server, command and exit code, "No test was run", the
  last 40 lines of the build output, the log path) or `build_config_invalid`; build timing kept in that verdict.
- `src/Verdict.ts`: `timing.build_ms`, `timing.build_check_ms`, `timing.server_restart_ms`, top-level `serving`
  (all optional when decoding, so stored verdicts still decode). `overhead_ms` and `ready_wait_ms` no longer
  contain the build. Summary text: `build 1.1 s`, `served from a build`.
- `src/Api.ts`: body field `serve`. `bin/cook.mjs`: `--serve auto|dev|build`; `cook status` prints
  `serving a build (<command>)` or `dev serving (<command>)` per web server. `src/Classify.ts`:
  `ServerSnapshot.mode?`. `src/index.ts`: exports.
- `test/Build.test.ts` (new, 12 tests; temp directories only, no browser, no app): config validation, plan,
  freshness decision with a stubbed file system and on real files, verdict timing. `test/Coordinator.test.ts`:
  one stub gained `mode: "dev"`.
- `scripts/bench-serve.mjs` (new): dev against build serving through `cook run --json`, taking turns.
- Fixture: `fixtures/react_app/cook.config.json` (new) and one line in `fixtures/react_app/package.json`
  (`"preview": "vite preview"`; `build` existed). Nothing else. The `dist/` my runs built there was removed
  (it is git-ignored anyway).
- No Effect API was used that `packages/cook` did not already use (`Schema.Struct/Union/Array/optionalKey/
  Literals/decodeUnknownSync`, `Effect.timeoutOption`, `Duration.millis`, `Option`, `Semaphore.makeUnsafe`,
  `Data.TaggedError`), so no Effect docs were fetched.

### How freshness is decided, and what was rejected
The project declares `inputs` (files, directories taken recursively, or globs; `node_modules` and `.git` inside a
directory are never walked; declared `outputs` and `ignore` are left out). Before a run Cook stats every input
file (size, mtime and ctime in nanoseconds) and compares with the record written when the last build started.
- Same file set, same stats: fresh, nothing is read. This is the cheap path.
- A file whose stats differ but whose size is the same is read and hashed (SHA-1, recorded at build time): equal
  content is not a change (a `touch`, a checkout, a generator rewriting the same text); the new stats are kept.
- A file recorded within 2 s of its last change is compared by content until it is older than that (coarse
  file system clocks could hide a second write).
- Stale, with the reason in `serving.servers[].rebuilt`: no record, other commands / env / declared paths
  (`buildKey`), file added, removed or changed, input unreadable, declared output missing, or an output file
  added, removed or changed by something other than Cook's build.
- A declared literal path that does not exist, or inputs matching no file, is a `build_config_invalid` error:
  a build whose inputs cannot be seen cannot be called current.
- The inputs are stamped before the build starts, so a save during the build makes the next run build again.
  The record is deleted before a build and written only after exit code 0 (and after the outputs exist), so a
  failed or half-finished build is never trusted.
- After any rebuild the project's servers are stopped first and started after the build, so the served process
  always belongs to the new build. No test runs meanwhile (one run per project path).
Rejected: git (not every project or container has it; untracked and ignored-but-read files are missed);
modification times alone (a rewrite inside one clock tick, or `cp -p`, is missed; a touch rebuilds for nothing);
hashing every file on every run (cost grows with the tree; the stat path is 1 ms on the fixture); inferring
inputs from the bundler (engine must not know Vite); a file watcher as the source of truth (events are lost
while the daemon is down; it can be added as an accelerator, see next steps).

### Verified
2026-10-04, this machine, `COOK_HOME=<session scratchpad>/home` (it already held the earlier stages' store, so
durations for longest-first existed), `COOK_PORT=43061`, fixture on `PORT=43921`, scratch copy on `PORT=43922`.
I was the only agent; load average (1 min) before each run is given per series and is this work's own.
- `npm run check`: typecheck clean, biome clean, 13 test files, 76 tests passed, 1.36 s (run again after the
  last edit and after the daemon was stopped).
- First build-served run (fixture, one file): pass, `build_ms 1001`, `server_restart_ms 517`,
  `build_check_ms 1.8`, `serving.servers[0] = {mode "build", rebuilt "no build recorded"}`.
  `cook status`: `webServer[0]: ready, serving a build (npm run preview -- --port $PORT --host 127.0.0.1
  --strictPort), pid ..., started 1x`.
- Fixture, 45 tests, `node scripts/bench-serve.mjs ../../fixtures/react_app --env PORT=43921 --runs 8 --workers 8`,
  8 timed runs per configuration taking turns (one untimed full run after every change of mode, so every timed
  run was warm: `server_restart_ms` null in all 32). Wall = `cook run --json` start to exit. Load 3.9 to 13.0.

  | configuration | wall p50 | min | max | p50 / max without the rerun | failing runs | flaky / other failures |
  |---|---|---|---|---|---|---|
  | dev serving, project's workers (12) | 6.72 s | 6.37 | 7.90 | 6.69 / 7.28 | 1 of 8 | 1 / 0 |
  | dev serving, 8 workers | 7.27 s | 7.01 | 8.56 | 7.27 / 7.76 | 1 of 8 | 1 / 0 |
  | build serving, workers from the file (8) | 4.45 s | 4.30 | 5.57 | 4.45 / 4.66 | 1 of 8 | 1 / 0 |
  | build serving, `--workers 8` | 4.50 s | 4.43 | 5.67 | 4.50 / 4.58 | 1 of 8 | 1 / 0 |

  Second series, build serving only, 8 runs each taking turns, load 5.8 to 9.5:
  `--workers 12`: p50 5.01 s, max 6.16 (5.15 without the rerun), 1 flaky failure;
  `--workers 8`: p50 4.51 s, max 5.63 (4.65 without the rerun), 1 flaky failure.
  Previous stage: 6.69 s p50 on dev; profile's hand-made best: 4.5 s.
- Freshness check when nothing changed, `timing.build_check_ms` over the 16 build-served benchmark runs:
  p50 0.9 to 1.0 ms, max 1.8 ms (includes reading `cook.config.json`).
- Cost of a change, on a scratch copy of the fixture (`<scratchpad>/app`: `cp -a` of the fixture, a
  `<p data-testid="cook-marker">marker-N</p>` added to `src/routes/index.tsx`, `marker.txt`, and
  `e2e/zz-marker.spec.ts` asserting the page shows the text in `marker.txt`; 46 tests). Each edit rewrites the
  marker in the source and in `marker.txt`; time is from the save to the exit of `cook run --json`. 5 runs per
  row, not interleaved between modes (dev block, then build block), load 4.4 to 12.1.

  | save to verdict, p50 (range) | dev serving | build serving | check / build / restart (build serving) |
  |---|---|---|---|
  | full run, nothing changed | 6.78 s (6.64 to 8.11, one flaky rerun) | 4.54 s (4.37 to 4.72) | 0.6 to 1.2 ms / none / none |
  | full run after an edit | 6.74 s (6.55 to 8.22, one flaky rerun) | 6.10 s (6.04 to 6.44) | 0.8 to 1.7 ms / 1.10 s (0.97 to 1.15) / 0.57 s (0.50 to 0.63) |
  | one test file, nothing changed | 1.17 s (1.10 to 1.19) | 0.96 s (0.92 to 1.03) | 0.6 to 1.3 ms / none / none |
  | one test file after an edit | 1.11 s (1.04 to 1.18) | 2.62 s (2.37 to 2.67) | 0.6 to 1.0 ms / 1.09 s (0.96 to 1.12) / 0.51 s (0.48 to 0.60) |

  Plainly: after an edit build serving still wins a full run by about 0.6 s, and loses a one-file run by about
  1.5 s (2.4 times slower). The rebuild costs about 1.65 s (build + restart) on this fixture; build serving
  saves about 2.2 s on 46 tests, so the break-even is around 34 of the 46 tests.
- Stale-build check: in the 10 build-served runs after an edit above, the marker test passed every time against
  the text saved a moment before, with `rebuilt "changed: src/routes/index.tsx"` each time; the 10 unchanged
  build-served runs in between did not rebuild (`rebuilt null`, `build_ms null`). The opposite control (showing
  the marker test fail against a deliberately stale build) was not run.
- Changing mode: dev after build restarted the server in 933 ms and that first full run took 11.65 s (cold Vite
  transforms); build after dev: 6.10 s including a 930 ms build and a 540 ms restart.
- Failures over all 112 runs of this stage: 14 failing runs, all the `@flaky` test (`e2e/estimate.spec.ts:6`,
  every rerun `passed`). 0 "checkbox did not change its state" failures, 0 `error` verdicts.
- End state: `cook stop` done; daemon 3221331, browser server guard and all three web server guards gone
  (checked by pid); nothing listening on 43061, 43921, 43922; no `.cook-playwright.config.*` in the fixture or
  the scratch copy; `fixtures/react_app/dist` removed.
- `npx playwright test --list` in `fixtures/react_app`: `Total: 45 tests in 13 files` (config loads as before).

### Unverified / assumptions
- A failing build (the `error` verdict with the end of the build output) and the passing run after the fix:
  covered only by the unit test of the verdict and by reading the code. Not run for real.
- A bad `cook.config.json`, `--serve build` on a project without the file, a missing declared input: unit tests
  of `parseCookConfig` / `planServing` / `scanFiles` only; the resulting `build_config_invalid` verdict was not
  produced through the daemon.
- A full plain `npx playwright test` in the fixture after my change was not run (only `--list`). The change is
  one added script and one JSON file Playwright does not read.
- `serve` through HTTP was exercised only via the CLI (which sends it in the body). `cook status` was only
  looked at in build mode.
- The build record surviving a daemon restart (file in `$COOK_HOME/builds/`), an output changed by something
  else, several `webServer` entries, an entry matched by name, glob inputs in a real project, a build timeout,
  a save during a build: unit tests or reasoning only.
- Whether a serve process that writes into a declared output directory exists in practice; if one does, every
  run would rebuild ("build output changed outside Cook"), and the project should not declare that output.
- The freshness cost on a large tree was not measured (fixture: `src/` plus four files, about 1 ms).
- `fs.globSync` and `path.matchesGlob` on Node 24: used by the unit tests without a visible warning; I did not
  check their stability status in the Node docs.
- Playwright's default worker count on this machine is taken to be 12 (earlier handoffs); I did not read it.
- Tests now run against production code under `auto`; the differences that matter to a project (dev-only
  warnings, source maps in traces) were not looked at.

### Not done / next steps
1. On the new machine: `cd packages/cook && npm ci && npm run check`; `cd fixtures/react_app && npm ci`.
   The scratch copy, the store and all raw rows were under `/tmp/claude-1000/...` and do not exist there;
   recreate the scratch copy as described under Verified (three small additions to a `cp -a` of the fixture).
2. Verify a failing build: in the scratch copy break a source file (a syntax error), `cook run`: expect exit 2,
   `error.reason "build_failed"`, the Vite error in `error.message`, `timing.build_ms` set, and `cook status`
   showing no web server for the project; fix the file, run again: expect `pass` with
   `rebuilt "changed: ..."`. Also a bad `cook.config.json` and `--serve build` without a file.
3. Run plain `npx playwright test` in `fixtures/react_app` once (it uses port 4310 unless `PORT` is set).
4. Decide the mode rule for small runs after an edit. Today `auto` always build-serves an opted-in entry, which
   loses on a one-file run after an edit (2.62 s against 1.11 s). Switching to dev per run is not the answer:
   both modes share the project's port, a switch costs a restart (0.5 to 0.9 s) and a dev server restarted is
   cold (first full run 11.65 s). Candidates, in my order of preference:
   a. Watch-mode build (out of scope here): rebuild in the background when an input changes, so a run finds a
      fresh build. The design leaves room: `inspect` + `runBuild` + the restart in `WebServer.ensure` already
      run under the per-project lock and can be triggered by a watcher instead of a run; `decideFreshness`
      stays the authority, so a missed event still means a rebuild at run time. With the build off the path,
      a one-file run after an edit would be about 0.96 s plus whatever of the 0.5 s restart is still pending.
   b. A rule from recorded figures: when the build is stale and the server is already in dev mode, stay in dev
      if (recorded build + restart time) > (recorded dev wall - build wall for this selection). Needs the mode
      as a column on `runs` (it is only in the verdict JSON now).
5. A rebuild restarts all of the project's web servers, not only the one that was built. Narrow it if a
   project with a slow API server shows up.
6. `cook status` shows nothing for a project whose build failed (its servers are stopped); show the failure.
7. Carried over: run directories, logs and now build logs are never pruned.

### Gotchas
- In `scripts/bench-serve.mjs` the row named `build_default_workers` uses the workers from the project's file
  (8 on the fixture), not Playwright's default. Pass `--workers 12` to measure that.
- The wrapper config is removed whenever the project's servers are stopped; `startAll` writes it again. The
  entries are not learned again on a restart (no `--list`), only when the Playwright config or the env changes.
- The serve command runs through the shell with the entry's `env`, which is how `$PORT` in the fixture's file
  reaches `vite preview`. The URL is still the one in the Playwright config.
- In build mode an already running server on the entry's URL is never adopted, even with
  `reuseExistingServer: true`: the run ends `pool_not_ready` and says to stop it.
- The daemon's own environment is not part of the build key; only the project env (`--env`) and the entry's
  `env` are. A build that depends on other variables is not rebuilt when they change.
- A build that writes into its own declared inputs with new content causes one extra rebuild on the next run.
- `timing.build_check_ms` is a fraction of a millisecond figure (one decimal), unlike the other timings.
- The diagnostic rerun also checks freshness, so a save between the first run and the rerun rebuilds inside
  `diagnostic_rerun_ms`.
- The daemon runs the code it started with: restart it after editing `src/`.

### Interfaces
Project file, `cook.config.json` in the project root (the directory given to `cook run`). Absent: the project
behaves exactly as before. The fixture's:
```json
{
  "webServers": [
    {
      "entry": 0,
      "build": "npm run build",
      "serve": "npm run preview -- --port $PORT --host 127.0.0.1 --strictPort",
      "inputs": ["src", "vite.config.ts", "tsconfig.json", "package.json", "package-lock.json"],
      "outputs": ["dist"]
    }
  ],
  "workers": { "build": 8 }
}
```
- `webServers[]`: one per `webServer` entry of the Playwright config that can be build-served.
  `entry`: index or `name` of that entry, default 0. `build`, `serve`: shell commands, run in the entry's `cwd`
  with the daemon env + `--env` + the entry's `env`. `inputs` (required, not empty): files, directories or
  globs relative to the project root. Optional: `ignore` (paths or globs), `outputs` (files or directories the
  build writes; recommended), `buildTimeoutMs` (default 300 000).
- `workers`: `{ "dev"?: n | "50%", "build"?: n | "50%" }`, used when the run names no worker count; `build`
  applies when at least one server is build-served.
- Errors: `error.reason "build_config_invalid"` with a sentence naming the file, the key and the problem.

CLI: `cook run ... [--serve auto|dev|build]` (default `auto`: entries named in the file are build-served;
`dev`: the Playwright config's own commands; `build`: as `auto`, but an error when the project has no build
described). HTTP `POST /api/runs`: body field `"serve"` with the same values; anything else is a 400.
`GET /api/status`: web servers gain `"mode": "dev" | "build"` and `"detail": "<command>"`.

Verdict, additive:
```json
{"timing":{"...":0,"build_ms":1099,"build_check_ms":0.9,"server_restart_ms":570},
 "serving":{"requested":"auto","servers":[{"name":"webServer[0]","mode":"build","rebuilt":"changed: src/routes/index.tsx"}]}}
```
`build_ms`: wall time of the build command(s), null when nothing was built; inside `duration_ms`, in none of
`overhead_ms`, `ready_wait_ms`, `tests_ms`. `build_check_ms`: the freshness decision, null when no server is
build-served. `server_restart_ms`: stop + start until ready after a build or a change of mode, null when the
servers were already running; it is inside `ready_wait_ms` and `overhead_ms`. `rebuilt`: why the build ran in
this run, else null. New `error.reason` values: `build_failed`, `build_config_invalid`.

TypeScript: `RunRequest.serve`, `RunOptions.serve`, `RunResult.serving: Serving`, `WebServer.ensure(project,
{ serve? })` -> `WebServers` with `serving` and `workers?`, `WebServerInfo.mode`, `ServerSnapshot.mode?`,
`BuildError`; from `src/Build.ts`: `CookConfig`, `parseCookConfig`, `loadCookConfig`, `planServing`,
`scanFiles`, `stampInputs`, `stampOutputs`, `decideFreshness`, `buildKey`, `BuildRecord`, `ServeRequest`,
`ServeMode`, `serveRequests`, `cookConfigName`.
Files: `$COOK_HOME/builds/<id>-<index>.json` (build record), `$COOK_HOME/logs/build-<id>-<index>.log`.
Benchmark: `node scripts/bench-serve.mjs <project> [--env K=V]... [--runs 8] [--workers 8] [--out f.jsonl]`
against a running daemon.
