# Cook TypeScript engine: design decisions

Written by the orchestrator 2026-10-04 after the owner decided: "re-write in typescript
with effect.ts; run a cloudflare container spike". These are decided unless marked OPEN.
If one turns out to be impossible, say so in your handoff with evidence; do not quietly do
something else. `DESIGN.md` describes the Elixir engine, which is now frozen (kept working,
no new features); read it only for the verdict and CLI behaviour that carry over.

## What Cook is now
A warm runner for any project tested with Playwright Test (`@playwright/test`). Nothing in
the engine may be specific to React, TanStack, Vite or Cloudflare. The first target is
`fixtures/react_app` (see `.handoff/react-fixture.md`), which knows nothing about Cook.
The same engine must later run unchanged inside a Linux container (Cloudflare Containers),
so: no dependence on Docker, Postgres, Erlang, a desktop session, or fixed ports.

## Environment (verified)
- Node v24.21.0, npm. Fixture: `@playwright/test` 1.63.0, Chromium already cached.
- Fixture numbers with plain `npx playwright test`, 45 tests, 12 workers: 12.8 s with no
  server running, about 10.9 s against an already running dev server. So for this target the
  dev server, not boot, is most of the time. Cook must not be sold on boot savings it does
  not deliver; every stage reports its numbers next to these.
- Ports 4002, 4040, 4041 belong to the Elixir engine; 4310 is the fixture's default.

## Stack
- TypeScript on Node 24, npm, in `packages/cook` (the Elixir app stays at the repo root for
  now; moving it is a later, separate change).
- Effect (https://effect.website) is the owner's choice for the engine: services and layers
  for the long-lived parts, scoped resources for OS processes, Schema for the verdict and API
  payloads, the platform packages for HTTP, filesystem and child processes. Effect moves
  fast: fetch current docs through Context7 before writing against it and confirm every
  export in the installed `node_modules`. Use the current stable major, pinned exactly.
- Storage: SQLite through Node's built-in `node:sqlite`, in a Cook state directory
  (`COOK_HOME`, default `~/.cook`). No external database.
- Tests: unit tests only, no browsers and no app boot, whole suite well under 30 s. Anything
  that drives a browser to test Cook itself runs only in GitHub Actions.

## Shape
```
cook (CLI, thin client: must not import the engine or Effect; plain fetch)
   │ HTTP on 127.0.0.1:COOK_PORT (default 4050)
   ▼
cook daemon (Effect)
  per Playwright version : BrowserServer  = the project's own `playwright run-server`
  per project path       : WebServer(s)   = the project's `webServer` command(s), kept running
  per run                : Runner         = the project's own `playwright test`, pointed at both
  Store (SQLite): runs, test_results
```

### Facts already checked in the Playwright docs (2026-10-04)
- `PW_TEST_CONNECT_WS_ENDPOINT=ws://host:port/` makes the stock runner use a remote
  Playwright server (`use.connectOptions.wsEndpoint` is the config form).
- The server rejects a client whose Playwright major.minor differs, so the browser server is
  started from the target project's own `node_modules`, and keyed by that version.
- `--reporter=json` with `PLAYWRIGHT_JSON_OUTPUT_NAME=<file>` writes the result tree: per test
  status, duration, errors with location, attachments (traces), retry index.
- CLI flags: `--retries`, `--timeout`, `--workers`, `--list`, `--only-changed[=ref]`,
  `--output`, file and `file:line` arguments. `webServer.reuseExistingServer` exists.

### Rules that carry over from the spec
- Nothing cold inside a run. If a run has to start a browser server or web server, that is
  recorded as overhead and is a pool bug, not normal behaviour.
- No retries: `--retries=0` always. A failure is reported once.
- Per-test cap, default 10 000 ms, with a message that says to split the test.
- One run at a time per project path; callers queue.
- If the browser server or web server dies during a run, the verdict is `error` with a
  reason, the pool restarts it, and the next run works.
- Verdict `cook.verdict/1` with the same keys as the Elixir engine (see `lib/cook/runs/`
  and the README's example); additive fields allowed. `repro` = `cook run <path> <file>:<line>`.
- Exit codes: 0 pass, 1 fail, 2 error. `--json` prints only the verdict.

## OPEN, to be settled by the stage that meets them, with evidence
1. How the daemon learns the project's `webServer` entries (command, url/port, cwd, env) and
   keeps the runner from starting or killing its own copy. Candidates: load the config with
   the project's own Playwright (internal loader, version risk); import the config file
   directly (Node 24 strips types); a generated wrapper config that re-exports the project's
   config with `webServer` removed (mind that paths resolve relative to the config file); or
   relying on `reuseExistingServer`, which fails for projects that set it false. A project
   with no `webServer` must also work.
2. Whether spawning `playwright test` per run is fast enough (measure spawn to first test),
   or the runner process itself has to be kept warm.
3. Scheduling longest-first: Playwright orders work itself; find out what control exists
   before promising it.

## Stages (one agent each, in order)
1. `ts-pool`: package scaffold, daemon skeleton, BrowserServer, WebServer, and one function
   that runs a project's suite against the warm pool and returns the raw Playwright JSON
   plus timings. Settles OPEN 1 and measures OPEN 2.
2. `ts-runs`: run coordination and crash handling, verdict, SQLite store, HTTP API, the
   `cook` CLI.
3. `ts-bench`: cold baseline for the React fixture, warm benchmark, CI job, README.
Parallel, independent: `cloudflare-spike` in `spike/cloudflare` (throwaway code).
