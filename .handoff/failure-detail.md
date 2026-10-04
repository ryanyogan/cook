# Stage 3a: failure-detail

## Status
COMPLETE (2026-10-04). `console_errors` and `server_logs` work as stage 2 built them. No Cook code was changed.

## Done
- Proved both fields with a temporary copy of the sample app (in the session scratchpad, deleted afterwards).
  Temporary edits in the copy only:
  - `PageController.home/2`: `Logger.warning("cook-probe http #{tag}")` when `?probe=<tag>` is given (plain HTTP request).
  - `UserLive.Login`: `handle_event("cook_probe", %{"tag" => tag}, …)` doing `Logger.error("cook-probe lv #{tag}")` plus a flash
    (LiveView event over the websocket).
  - `test/features/probe_a_test.exs` and `probe_b_test.exs` (async, tags `A` / `B`): visit `/?probe=<tag>`,
    `evaluate("console.error('cook-probe console <tag>')")`, an uncaught `throw new Error('cook-probe uncaught <tag>')` in a
    `setTimeout`, a `console.log` (must not be collected), visit the login LiveView, push `cook_probe` with
    `liveSocket.execJS`, assert the flash, then fail on a missing element.
- Nothing in the repo differs from before: no changes in `lib/`, `test/`, `fixtures/sample_app`; `config/config.exs` restored.

## Verified
Real daemon (`bin/cook start --detach`), real browsers, 2026-10-04.
- `bin/cook run <copy> test/features/probe_a_test.exs:4 test/features/probe_b_test.exs test/features/home_test.exs --json`:
  exit 1, `selected 5`, `counts {passed 3, failed 2}`, 2726 ms. Failure entries (verbatim):
  - `probe_a_test.exs:4`: `console_errors: ["cook-probe console A", "uncaught: cook-probe uncaught A"]`,
    `server_logs: ["[warning] cook-probe http A", "[error] cook-probe lv A"]`, `dom_snapshot` set.
  - `probe_b_test.exs:4`: `console_errors: ["cook-probe console B", "uncaught: cook-probe uncaught B"]`,
    `server_logs: ["[warning] cook-probe http B", "[error] cook-probe lv B"]`, `dom_snapshot` set.
  - Isolation: no `B` line in A's entry and no `A` line in B's. The two tests ran concurrently: `test_results` has both at
    `started_ms 0`, `duration_ms 2679`.
  - The `console.log` line was not collected (errors only).
- Two full-suite runs of the copy (`bin/cook run <copy> --json`, 46 tests, 8 modules in parallel): both probe entries had
  exactly the same four lines each, both times. In the second run the flaky `delivery_estimate_test.exs:8` also failed with
  `console_errors: []`, `server_logs: []` (it emits nothing, and no probe line leaked into it).
- So the stage 2 assumptions hold: `page_error` does arrive on the browser-context channel (the `uncaught:` lines), the
  owner is found for a plain request (`[:phoenix, :endpoint, :start]`) and for an event in a connected LiveView
  (`[:phoenix, :live_view, :mount, :start]`, User-Agent from `connect_info`).
- After cleanup: `find fixtures/sample_app` (path, size, mtime; without `deps`, `_build`) hashes to the same md5 as before
  the work; `mix precommit` 73 passed; no `run-server`, `cook_app_*`, `phx.server`, `port_wrapper` or epmd processes.

## Unverified / assumptions
- Logs of processes that are neither the test, nor have it in `$callers`, nor serve a request/LiveView with its
  User-Agent (e.g. a GenServer or PubSub subscriber acting for the test) are not attributed. Not probed.
- A LiveView socket without `:user_agent` in `connect_info` would lose LiveView-event logs (the sample app has it).
  Not probed.
- Sessions from `new_browser_session/1`: still not covered by console collection or snapshot (stage 2 note, unchanged).
- Lines below the app's logger level never reach the handler (the sample app is at `:warning` in test), so
  `server_logs` holds warnings and errors only. By design, not probed further.

## Not done / next steps
1. Nothing required. Optional: an env var (e.g. `COOK_APP`) to point the daemon at another app path, see Gotchas.

## Gotchas
- The daemon serves only the apps in `config :cook, Cook.Pool, apps:`; any other path returns `unknown_app` (exit 2).
  To run a copy I temporarily edited the path in `config/config.exs` (recompiles 32 files) and restored it.
- A copy made with `cp -a` including `deps` and `_build` boots without a cold compile and shares the
  `sample_app_test` database with the original, which is fine as long as only one instance runs.
- `cook_dev` now has 4 run rows (and their `test_results`) whose `path` is the deleted scratchpad copy, and `artifacts/`
  has their directories until pruned. They are keyed by path and do not affect ordering for the real sample app.
- `pgrep chrom` also matches the user's desktop Chromium (`/usr/lib/chromium`); it is not Cook's.

## Interfaces
Unchanged. Failure entry fields confirmed in a real verdict:
- `console_errors`: list of strings; console `error` messages as text, uncaught page errors as `"uncaught: <message>"`.
- `server_logs`: list of strings formatted `"[<level>] <message>"`, in emission order, at most 200 lines per test.
