# react-fixture (React + TanStack Start fixture under `fixtures/react_app`)

## 2026-10-04

### Status
COMPLETE

### Done
All paths relative to `fixtures/react_app`. Nothing outside that directory was touched except this file.

Stack: TanStack Start (React) on Vite, npm, Node 24. No fallback was needed. Data is in SQLite through
`node:sqlite` (file `data/app.sqlite`, created on first request, gitignored). No native dependency.

App ("Taskboard"):
- `vite.config.ts` (port from `PORT`, default 4310, `strictPort`, host 127.0.0.1), `tsconfig.json`, `.gitignore`.
- Server: `src/server/db.ts` (schema, connection kept on `globalThis`), `src/server/store.ts` (all logic),
  `src/server/session.ts` (cookie `sid`, httpOnly). Server functions: `src/lib/fns.ts`. Types: `src/lib/types.ts`.
- Pages in `src/routes/`: `index`, `signup`, `login`, and behind `_authed.tsx` (redirects to `/login`):
  `tasks.index` (list, search `?q=`, status filter `?status=`), `tasks.new`, `tasks.$taskId.index`,
  `tasks.$taskId.edit`, `activity` (polls every 500 ms), `exports` (background job), `reports`, `import`, `settings`.
- JSON API (server routes) in `src/routes/api/`: `POST /api/signup`, `POST /api/login`, `GET|POST /api/tasks`,
  `GET /api/health`. The tests use it to set up users and tasks.
- Background job: `startExport` in `store.ts` inserts a `queued` row, returns, and a 600 ms timer marks it `done`.
- All data is scoped to the signed-in user; there is no shared or seeded data.

Tests: 45 in 13 files under `e2e/` (plain `@playwright/test`), helpers in `e2e/fixtures.ts`
(`account` fixture = new user signed up through the API on the test's own context, `visit`, `createTask`, `uid`).
auth 8, home 2, task-create 5, task-edit 4, task-delete 2, task-list 7, activity 4, exports 3, settings 3,
reports 2, import 3, workflow 1, estimate 1.
- Slow (tag `@slow`): `e2e/reports.spec.ts:13` (server spends 150 ms per task, 12 tasks),
  `e2e/import.spec.ts:32` (server spends 100 ms per line, 20 lines), `e2e/workflow.spec.ts:4` (about 45 UI steps).
- Flaky (tag `@flaky`, title starts `FLAKY:`): `e2e/estimate.spec.ts:6`. Cause is on the server:
  `ESTIMATOR_FAILURE_RATE = 0.2` in `src/server/store.ts`.
- `playwright.config.ts`: Chromium only, `fullyParallel`, `retries: 0`, `trace: 'retain-on-failure'`,
  viewport 1280x720, locale en-US, timezone UTC, `reducedMotion: 'reduce'` (the app's CSS turns off transitions
  and animations under that media query), `webServer` = `npm run dev`, `reuseExistingServer: !process.env.CI`.
  Nothing Cook-specific. Workers are Playwright's default (12 on this 24-core machine).

### Verified (final code unless noted; run from `fixtures/react_app`)
- Versions (`npm ls --depth=0`, `node --version`): Node v24.21.0, npm 11.19.0, `@playwright/test` 1.63.0,
  react / react-dom 19.3.0, `@tanstack/react-start` 1.168.60, `@tanstack/react-router` 1.170.41, vite 8.3.2,
  `@vitejs/plugin-react` 6.1.1, typescript 7.0.2.
- Chromium: Playwright 1.63.0 wants revision 1243, already in `~/.cache/ms-playwright`. Nothing was downloaded.
- `npx tsc --noEmit`: exit 0.
- Cold, no server running: `npx playwright test` -> 45 passed, 12.8 s wall (Playwright reports 12.2 s). Port 4310 was
  free again afterwards. Two earlier cold runs on near-final code: 12.9 s (Vite dep cache deleted first, 45 passed)
  and 13.1 s (44 passed, the `@flaky` test failed).
- Against a running `npm run dev`: same command, 10.8 to 11.0 s wall. It reused the server: the Vite process id was
  unchanged before and after, and `strictPort` would have made a second server fail to start.
- 10 full runs in a row against one long-lived server (final code): failures other than `@flaky` per run:
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0. The `@flaky` test failed in runs 1 and 2. Wall per run 10.76 to 11.04 s.
  Two earlier 10-run series on the same server, before small test edits: also 0 non-flaky failures in every run.
  That server had served about 30 full runs plus 200 flaky repeats by the end; no slowdown seen.
- Flaky rate: `npx playwright test e2e/estimate.spec.ts --repeat-each 200` -> 163 passed, 37 failed (18.5%).
  Across the 30 full runs it failed 4 times. A failing run takes about as long as a passing one (the error check is
  not polled).
- Slow tests alone (`--grep @slow`, measured before the workflow test lost one task): import 2.9 s, report 3.1 s,
  workflow 4.3 s. Inside the full parallel suite (final code): import 3.7 to 4.1 s, report 3.8 to 4.0 s,
  workflow 4.2 to 4.3 s.
- One file: `npx playwright test e2e/settings.spec.ts` -> 3 passed, 1.3 s. One test:
  `npx playwright test e2e/import.spec.ts:32` -> 1 passed, 3.3 s. `--grep-invert @flaky` -> 44 passed.
- `PORT=4311 npx playwright test e2e/home.spec.ts` (cold) -> 2 passed; the server came up on 4311.
- No `waitForTimeout` in `e2e/`. No dev server or browser left running at the end (`pgrep`, `ss -ltn`).

### Unverified / assumptions
- Timings are noisy: load average was 8 to 15 during the runs, partly from this suite and partly from other work
  on the machine. Treat wall times as +/- 1 s.
- `CI=1` (which sets `reuseExistingServer: false` and the `github` reporter) was not run.
- `npm run build` and the production server were not run; only `vite dev` was exercised.
- Worker counts other than the default 12 were not tried, apart from 3 workers for the slow-only run.
- The cause of the "Failed to fetch" lines in the dev-server log (see Gotchas) is inferred, not proven.
- The workflow test alone was not re-timed after it was shortened from 6 tasks to 5.

### Not done / next steps
- Nothing outstanding from the brief.
- If a later stage wants a production-mode target, add and verify a `build` + `start` path first.

### Gotchas
- Median test time inside the full suite is about 1.5 s even for small tests: 12 workers share one single-threaded
  Vite dev server that server-renders every page. A file run alone is far quicker per test (3 tests in 1.3 s).
  The dev server is the bottleneck, not the browser.
- Hydration. Pages are server-rendered, and forms do nothing until React hydrates. The root route sets
  `data-hydrated="true"` on `<html>` in an effect; `visit()` in `e2e/fixtures.ts` waits for it. Use `visit`, not a
  bare `page.goto`, before typing or clicking.
- The dev-server log shows `[vite] (client) [console.error] TypeError: Failed to fetch` with a React error-boundary
  warning about once every two or three full runs. Vite forwards browser console output to the terminal. No test
  failed in any of those runs; the likely cause is a test ending while a loader refetch is still in flight, so the
  request is cut off when the context closes. Do not read those lines as test failures.
- `vite.config.ts` tells the watcher to ignore `data/`, `test-results/` and `playwright-report/`. Without that,
  every SQLite write and every trace file wakes Vite's file watcher.
- The database only grows: about 1 MB plus a 4 MB WAL after roughly 30 runs. Delete `data/` (with the server
  stopped) to start clean. Nothing depends on it being empty or on it being kept.
- The background-job timer and the open database handle live in the dev-server process. Restarting the server
  mid-run loses queued exports (they stay `queued`).
- `createServerFn(...).validator(...)` is the current name in 1.168; `inputValidator` still exists but is marked
  deprecated in the installed types.
- `src/routeTree.gen.ts` is generated by the Start plugin when the dev server starts. It is not gitignored because
  `tsc` needs it; expect it to be rewritten.
- `/usr/bin/time` and `bc` are not installed on this machine; time with the shell's `time` or `date +%s%N`.
- `pkill -f` with a pattern that also appears in your own command line kills your own shell. Kill by pid.

### Interfaces
Run all of these from `fixtures/react_app`.
- Install: `npm install` (Chromium 1243 is already cached; otherwise `npx playwright install chromium`).
- Start the dev server: `npm run dev` (http://127.0.0.1:4310; other port: `PORT=4311 npm run dev`).
  Ready when `GET /` or `GET /api/health` answers 200.
- All tests: `npx playwright test` (starts the server itself if none is listening; reuses one if it is).
- One file: `npx playwright test e2e/task-list.spec.ts`
- One test by line: `npx playwright test e2e/import.spec.ts:32`
- By tag: `npx playwright test --grep @slow`, `--grep @flaky`, `--grep-invert @flaky`.
- Typecheck: `npx tsc --noEmit`.
- Env: `PORT` (server port and `baseURL`), `DATABASE_PATH` (default `data/app.sqlite`), `CI` (disables server reuse).
- Output: `test-results/<test>/trace.zip` for failed tests only.
