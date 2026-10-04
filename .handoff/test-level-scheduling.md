# Stage 4: test-level-scheduling

## Status
COMPLETE (2026-10-04). The 10x acceptance item now passes: warm p50 4433 ms = 10.67x (was 5321 ms = 8.89x).
The sample app, its tests and `bench/baseline.json` were not changed.

## Done
- `lib/cook/agent/shards.ex` (`Cook.Agent.Shards`, injected into the instance; the only code that depends on
  ExUnit internals, listed in its moduledoc). It cuts `async: true` modules into "shards": generic proxy modules
  `Cook.Agent.Shards.Slot<N>` whose `__ex_unit__/0` returns the real module's `%ExUnit.TestModule{}` with a
  subset of `tests`, and whose `__ex_unit__(:config)` returns the real module's config. Slots are created once
  with `Module.create/3` and read a table in `:persistent_term` that is replaced every run, so nothing is
  compiled per run and a reloaded test file needs no refresh (the table is built from the fresh struct).
- Modes: `:packed` (default; first-fit decreasing per module with capacity = slowest recorded test among the
  selected tests; a module that fits in one bin stays the real module; a module with an unknown duration gets
  one shard per test), `:test` (one shard per test), `:off`.
- A module is not split when: `async: false`, `:group`, `:parameterize`, `@moduletag cook_split: false`, a
  single test, the run has `file:line` references, or it has `setup_all` and the test file's own source
  mentions `setup_all` (or cannot be read). `setup_all` coming only from a case template is accepted.
- Guards: unreadable module -> runs whole (`unsplit` reason `unreadable`); any exception in planning or slot
  creation -> whole modules in the old module order, `scheduling.fallback` carries the message.
- `lib/cook/agent.ex`: `do_run` calls `Shards.prepare/3`; new options `:shard`, `:durations`; report gets
  `scheduling`; `module_failures` de-duplicated (a failing `setup_all` is reported once per shard by ExUnit).
- `lib/cook/pool.ex` (`agent_opts` adds `shard`, `durations`; result adds `scheduling`),
  `lib/cook/pool/app_instance.ex` (injects `Cook.Agent.Shards`), `lib/cook/runs/runner.ex` (one
  `recent_durations` query feeds `module_order` and `durations`), `lib/cook/runs/ordering.ex`
  (`test_durations/1`), `lib/cook/runs.ex` (`recent_durations` also selects `name`, `status`),
  `lib/cook/verdict.ex` (additive `scheduling`).
- `config/config.exs`: `shard: :packed`; `config/runtime.exs`: `COOK_SHARD`, `COOK_MAX_CASES`.
- Tests: `test/cook/agent/shards_test.exs` (17), `test/support/fake_test_module.ex`, additions to
  `test/cook/pool_test.exs` and `test/cook/runs/ordering_test.exs`.
- `bench/warm.json` overwritten; `README.md` numbers, new "Scheduling" section, limitations; a dated note in
  `.handoff/DESIGN.md`.

## Verified
All on this workstation, 2026-10-04, daemon started with `bin/cook start --detach` (default config unless noted).
- ExUnit source (`runner.ex` 241-246, 319-357, 526; `case.ex` 629-653; `ex_unit.ex` 478-479): the runner calls
  `module.__ex_unit__()`, then `setup_all` on `test_module.name` and `setup` on `test.module`.
- `mix cook.bench` (20 runs, written to `bench/warm.json`): **15 pass, 5 fail, 0 error**; wall p50 **4433** /
  p95 **4481** ms; `duration_ms` 4410 / 4455; `first_test_ms` 47 / 52; start to first test 72 / 77.
  **10.67x at p50, 10.55x at p95.** `selected` = 44 in all 20. All 5 failures are `delivery_estimate_test.exs:8`.
- Before (stage 3b, same machine and baseline): p50 5321 / p95 5426, 8.89x / 8.71x, 14 pass, 6 fail, 0 error.
- Settings, 8 full runs each after one warm-up (`COOK_SHARD`, `COOK_MAX_CASES`), wall p50 / p95, failures:
  | shard | max_cases | units | p50 | p95 | pass/fail | failing tests |
  | --- | --- | --- | --- | --- | --- | --- |
  | off | 8 | 14 | 5343 | 5425 | 6/2 | delivery_estimate:8 x2 |
  | packed | 8 | 15 | 4437 | 4484 | 7/1 | product_management:6 x1 |
  | test | 8 | 44 | 4440 | 4473 | 5/3 | delivery_estimate:8 x3 |
  | test | 16 | 44 | 4829 | 4941 | 6/2 | delivery_estimate:8 x2 |
  | test | 44 | 44 | 5675 | 5787 | 6/2 | delivery_estimate:8 x2 |
  Two more 20-run benches (scratch files, not committed): `test`/8 p50 4468 / p95 4508, 17 pass 3 fail;
  `packed`/8 p50 4455 / p95 4505, 15 pass 5 fail; all failures `delivery_estimate_test.exs:8`.
  Higher concurrency caused no new failures but made the slowest test slower, so `max_cases` stays 8.
  `packed` and `test` are equal in time; `packed` is the default because it splits 1 module instead of 14
  (15 `setup_all` runs / browser launches instead of 44).
- Failure set across the 100 full runs with sharding on: `delivery_estimate_test.exs:8` (intentional) and
  `product_management_test.exs:6` once (its module was whole in that run; 1/39 before, 1/100 now).
- `setup_all` cost: in runs where the slowest test's shard started first, `tests_ms - slowest_test_ms` was
  7-11 ms, which bounds the per-shard `setup_all` (Playwright `launch_browser` over the ws endpoint) plus
  ExUnit overhead.
- Explicit lists: `…/order_history_test.exs:22` -> selected 1, skipped 43, exit 0; two lines of one module ->
  selected 2; a whole file -> selected 3, 2 units; file + line -> selected 6. Runs with a line are not split
  (`unsplit` reason `file:line run`).
- Stored results of a full run: 44 rows, 14 distinct modules, 44 distinct test ids, no `Slot` module name;
  `counts.known` 44. Start order at t=0: the 8 longest units (the 4.4 s test first as its own shard).
- With three temporary test files (created, then deleted; `git status` shows nothing under `fixtures/`):
  a 10.5 s test in a split plain `ExUnit.Case` module -> `kind: cap`, exit 1; a module with its own `setup_all`
  -> `unsplit: own setup_all`, passes; an `async: false` module runs whole. After editing the file (new test,
  shorter sleep) the next run selected 4 with the new test and lines; after deleting them `known` was 44 again.
- Browser server `kill -9` 1.5 s into a full run: exit 2, `browser_server_down`, CLI back in 1626 ms; next run
  exit 0, 44/44 in 5535 ms; the one after 4.4 s. Same daemon pid.
- `mix precommit`: 102 passed (1 doctest, 101 tests).
- `bin/cook stop`, `pkill -x epmd`; `pgrep` for run-server / cook_app_ / port_wrapper / epmd is empty.

## Unverified / assumptions
- CI was not run (no remote). Its `selected == number of tests` check matches what the runs here returned.
- The instance-kill (as opposed to browser-kill) recovery was not re-run in this stage.
- `:group`, `:parameterize`, the `cook_split: false` tag and a failing `setup_all` in a split module are covered
  by unit tests on plain data or by reading ExUnit's source, not by a real run.
- "A template's `setup_all` is safe once per shard" is an assumption. It would break for a template that
  registers something under the module's name in `setup_all`; such a module needs `@moduletag cook_split: false`
  or `COOK_SHARD=off`.
- Only Elixir 1.20.4's ExUnit was checked.

## Not done / next steps
1. Orchestrator: push, and watch the e2e job (first run on CI with sharding).
2. Record a real duration for tests killed at the cap (see Gotchas) instead of 0.
3. If suites with many long modules appear, re-measure `max_cases`; 8 was chosen on this suite only.
4. `product_management_test.exs:6` is still an unmarked flake in the sample app (not this stage's to edit).

## Gotchas
- One daemon start (of about 15 in this stage) came up with the instance down for 120 s:
  `{:boot_failed, {:error, {:badmatch, false}}}`, i.e. `true = Node.connect(node)` in
  `Cook.Pool.AppInstance.attach/1` kept returning false; the run waiting on it ended `pool_not_ready`. It
  happened right after a `bin/cook stop` and did not reproduce in three attempts at the same sequence. It is
  before the agent is injected, so not caused by sharding, but it is unexplained.
- A test killed at the cap is stored with `duration_ms` 0 (ExUnit gives a timed-out test no time).
  `Ordering.test_durations/1` drops failed 0 ms entries, so the planner treats it as unknown; `module_order`
  still counts it as 0.
- `file:line` filters: ExUnit picks the closest test among the tests of the module it is handed, so a shard
  would match one test per shard. That is why line runs are never split. Do not remove that rule.
- `:packed` capacity is the slowest recorded test among the selected tests, with no margin. Bins equal to the
  capacity are allowed; the floor can exceed the slowest test by the jitter of a full bin.
- The slot table lives in `:persistent_term` and is replaced every run (one global GC per run, same as the
  agent state that was already stored there).
- Formatter events `module_started` / `module_finished` arrive once per shard with the real module's name.
- `Cook.Agent.Shards` follows the agent rule: no ExUnit struct patterns, plain map access only.
- More concurrency is slower here: one browser and one app are shared, and the slowest test stretches
  (4.4 s at 8 units, 5.6 s at 44).

## Interfaces
```elixir
Cook.Pool.run(path, shard: :packed | :test | :off, durations: [{module_name, test_name, ms}], max_cases: n, ...)
# result and verdict gain:
scheduling: %{mode: "packed" | "test" | "off", granularity: "test" | "module", units: n, split_modules: n,
              unsplit: [%{module: String, reason: String}], fallback: String (only after a failed split)}
Cook.Agent.Shards.prepare([{module, file}], opts, order_fallback) :: {modules_for_ex_unit, scheduling}
Cook.Agent.Shards.plan(described, durations_map, mode:, order:) | pack(items, capacity)
  | split_reason(test_module, config, %{source:, line_refs?:}) | describe(module, file, line_refs?)
Cook.Runs.Ordering.test_durations(recent_durations) :: [{module, name, ms}]
Cook.Runs.recent_durations(path)   # entries now also have :name and :status
```
```
config :cook, Cook.Pool, shard: :packed, max_cases: 8
COOK_SHARD=packed|test|off  COOK_MAX_CASES=N  bin/cook start --detach
@moduletag cook_split: false     # in a target app's test module: never split it
```
