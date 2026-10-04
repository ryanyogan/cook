# Next session: start here

Rewritten 2026-10-04 (afternoon) by the orchestrator after the owner changed the target.

## Direction change (owner, 2026-10-04)
"our target is a react app with playwright, not phoenix" and "it shouldn't be specific":
Cook should run any project tested with Playwright Test (`@playwright/test`). The owner's
own work is mostly React + TanStack on Cloudflare; they barely use Phoenix.

The owner then asked whether Cook should be built on Cloudflare's platform instead of as an
Elixir daemon. After the analysis in `.handoff/cloudflare-research.md` they decided
(verbatim): "re-write in typescript with effect.ts; run a cloudflare container spike".
The Elixir engine is frozen. The TypeScript design is `.handoff/DESIGN-TS.md`; its stages
are `ts-pool`, `ts-runs`, `ts-bench`, with `cloudflare-spike` in parallel. Check which
`.handoff/<stage>.md` files exist to see how far it got.

## State
- Phase 0 + Phase 1 (Phoenix target) are built and pushed: https://github.com/ryanyogan/cook,
  `main` at `521f5f3`, CI green (`unit` + `e2e`).
- Daemon start hang: fixed in `521f5f3` (cookie starting with `-` was dropped by `erl`);
  see `.handoff/daemon-start-hang.md`.
- `fixtures/react_app` (TanStack Start, 45 plain Playwright tests) is built; see
  `.handoff/react-fixture.md`. Plain `npx playwright test` takes 12.8 s with no server
  running and about 10.9 s against a running dev server (12 workers), so on this target
  the warm pool saves little locally; the dev server is the bottleneck.
- The spec `docs/cook-spec.md` is git-ignored and private (never commit it or quote its
  Chromatic section). It predates the direction change and is Phoenix-first.

## Shelved (Phoenix-only; pick up only if the owner asks)
- Unmarked flake `fixtures/sample_app/test/features/product_management_test.exs:6`, about
  1 failure per 100 full runs.
- Re-measure CLI start to first test; measure restart vs hot reload.
- A test killed at the per-test cap is stored with 0 ms duration.
- `Cook.Runs.Runner` still waits 120 s when an instance cannot boot for a reason other
  than the cookie.
- The Phoenix impact map (telemetry + `mix xref`).

## Verified Playwright facts for the next design (Context7 docs, 2026-10-04)
- `PW_TEST_CONNECT_WS_ENDPOINT=ws://host:port/ npx playwright test` makes the stock runner
  use a remote Playwright server; `use.connectOptions.wsEndpoint` does the same from config.
- The server rejects clients whose Playwright major.minor differs from its own, so the warm
  browser server has to be started from the target project's own Playwright version.
- `PLAYWRIGHT_JSON_OUTPUT_NAME=file npx playwright test --reporter=json` writes the full
  result tree (status, duration, errors, attachments such as traces, per test).
- CLI: `--retries`, `--timeout`, `--workers`, `--list`, `--only-changed[=ref]` (test files
  changed or importing changed files; git only), `webServer.reuseExistingServer`.

## How the owner wants this run
- Orchestrate through sub-agents; keep the main context small; each agent gets one narrow
  stage, stays under 170k context, writes `.handoff/<stage>.md`.
- Cook's own tests: simple unit tests only, no browsers and no app boot in the local test
  run. Browser-driven checks of Cook run only in GitHub Actions.
- The repo is public. Push only finished work and watch the Actions run after each push.

## Environment
- Postgres: `docker compose up -d --wait` in the repo root, port 5544, password `postgres`.
- Daemon: `bin/cook start --detach`, `bin/cook run [PATH] [TEST...] [--json]`,
  `bin/cook status`, `bin/cook stop`.
