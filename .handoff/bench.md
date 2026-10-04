# Stage 3b: bench

## Status
COMPLETE (2026-10-04). All seven tasks done. One acceptance item does NOT pass: the warm run is
8.89x faster than the baseline at p50, not 10x. Numbers were not tuned.

## Done
- Commits on `main` (local only, not pushed, no remote): `59df8ec` (state before this stage, 204 files),
  `fcbf23a` (this stage), plus one commit for this file.
- `bin/baseline [RUNS]`: `git archive HEAD fixtures/sample_app` into a temp dir, times `checkout`, `deps_fetch`
  (`mix deps.get`), `npm_install` (`npm ci --prefix assets`), `browser_install`
  (`npx --prefix assets playwright install chromium`), `compile`, `assets_build`
  (`mix do assets.setup + assets.build`), `db_setup` (`ecto.create` + `ecto.migrate`), `test`
  (`mix test test/features`), all with `MIX_ENV=test` and `MIX_TEST_PARTITION=_baseline_<pid>_<n>` (database
  `sample_app_test_baseline_<pid>_<n>`). Drops the database and the temp dir in an EXIT trap. Writes
  `bench/baseline.json` (`cook.baseline/1`): median total, per-phase medians, every run, machine, caveats.
  Refuses to write if a setup phase fails or no test result line is found.
- `lib/cook/bench/stats.ex` (pure: nearest-rank percentile, summarize, speedup, verdict counts, report),
  `test/cook/bench/stats_test.exs` (11 tests + 1 doctest), `lib/mix/tasks/cook.bench.ex` (`mix cook.bench`,
  options `--runs`, `--baseline`, `--out`; does not boot the Cook app). Writes `bench/warm.json` (`cook.bench/1`).
- `bench/baseline.json`, `bench/warm.json` (committed).
- `.github/workflows/ci.yml`: jobs `unit` and `e2e`.
- `README.md` replaced.

## Verified
All on this workstation, 2026-10-04.
- `bin/baseline 3` (daemon stopped): totals 47280 / 50236 / 47078 ms, median **47280 ms**. Phase medians:
  deps_fetch 6778, npm_install 221, browser_install 513, compile 27703, assets_build 4442, db_setup 551,
  test 7041. Runs 1 and 3: 44 passed; run 2: 43/44 (exit 2, the flaky test). Afterwards no
  `sample_app_test_baseline_*` database and no `/tmp/cook-baseline.*` dir.
- `bin/cook start --detach` (1.8 s), then `mix cook.bench`: 20 runs, **14 pass, 6 fail, 0 error**.
  wall p50 **5321** / p95 **5426** ms; `duration_ms` p50 5296 / p95 5400; `first_test_ms` p50 43 / p95 52;
  CLI start to first test (wall - duration + first_test) p50 68 / p95 77 ms. Speedup **8.89x p50**, 8.71x p95.
- `mix precommit`: 84 passed (1 doctest, 83 tests), 0.76 s wall. `mix format --check-formatted` passes.
- `python3 -c 'import yaml; yaml.safe_load(...)'` parses `ci.yml`.
- setup-beam versions: `builds.hex.pm` lists `v1.20.4-otp-29` and `OTP-29.0.x` for ubuntu-24.04.
- No processes left: `bin/cook stop`, then `pkill -x epmd`; `pgrep` for run-server / cook_app_ / phx.server /
  port_wrapper / epmd is empty.

### Acceptance
| item | result | evidence |
| --- | --- | --- |
| Baseline JSON exists and is committed | PASS | `bench/baseline.json` in `fcbf23a`, median of 3 real runs |
| Warm full run >= 10x faster at p50 | **FAIL** | 47280 / 5321 = 8.89x. A 10x result needs p50 <= 4728 ms; the suite's floor is its longest module (OrderHistory about 5.3 s serial, slowest test 4.4 s). The cold `mix test` phase alone is 7.0 s. |
| `cook run` to first test under 2 s | PASS | 20 warm runs: 53-77 ms (p50 68, p95 77). After a pool crash the next run's `first_test_ms` was 853 ms (browser) and 1601 ms (instance); stage 2 saw 1944 ms once, so the post-crash margin is thin. |
| Kill browser server mid-run -> `error`, pool recovers | PASS | `kill -9` of the node `run-server` process 1.5 s into a full run, twice: exit 2, `status error`, `error.reason browser_server_down`, CLI returned at 1531 ms. Next full run: exit 0, 44/44, `ready_wait_ms` 826. Same daemon pid. |
| Kill app endpoint/instance mid-run -> `error`, pool recovers | PASS (instance kill) | `kill -9` of the `cook_app_*` BEAM 1.5 s in: exit 2, `app_instance_down`, 1520 ms. Next full run: exit 0, 44/44, `ready_wait_ms` 1577. Same daemon pid. |
| Flaky test reported once, never retried | PASS | In the 20 bench runs `delivery_estimate_test.exs:8` has exactly one `test_results` row per run (20 runs: 14 passed, 6 failed), no `(run_id, test_id)` pair occurs twice, and each failing verdict lists it once. |
| README covers baseline, warm runner, benchmark | PASS | `README.md` |

## Unverified / assumptions
- The CI workflow has never run (no remote). Each command in it was checked against what works locally, but
  `--with-deps` on the runner, the Postgres service on port 5544, the cache keys, and the timing of the
  `sleep 1.5` kill on a slower runner are untested. `otp-version: "29"` is a loose spec (latest 29.x), local is 29.0.6.
- "App endpoint" was tested by killing the whole instance BEAM. Stopping only the Phoenix endpoint inside a
  living instance was not tried.
- The baseline's `browser_install` and `deps_fetch` used warm caches; `assets.setup` did download the
  tailwind/esbuild binaries each run (they live in `_build`).

## Not done / next steps
1. Orchestrator: create the remote, push, watch the first Actions run and fix whatever the runner disagrees with.
2. Decide what to do about the 10x item: it cannot be met on this suite without splitting the 5.3 s module
   (sample app owner) or scheduling below module granularity (Phase 2 material).
3. Look at `product_management_test.exs:6` (see Gotchas).

## Gotchas
- A second, unmarked flake in the sample app: `test/features/product_management_test.exs:6` failed once in 39
  recorded runs (bench run 4, `Could not find element "#flash-info" [text: "Product created."]`, 2605 ms).
  It was reported once and not retried. Not investigated; `fixtures/sample_app` is not this stage's to edit.
- Elixir 1.20 prints `Result: 44 passed` / `Result: 43/44 passed`, not `44 tests, 1 failure`. `bin/baseline`
  parses both forms.
- `mix test` exits 2 on test failures in this Elixir; `bin/baseline` records it as `test_exit_code` and still
  counts the run.
- `pgrep -f 'node.*run-server'` matches the wrapper shell first; killing that one is not noticed by the pool
  and the run passes. Use `pgrep -f '^[^ ]*node .*[r]un-server'` (the CI workflow does).
- `mix cook.bench` needs the dev build to exist (`mix compile` or a daemon start) and a running daemon.
- `.handoff/` is committed (it was untracked and not ignored). It contains no text from the private spec's
  Chromatic section, but the orchestrator may prefer to drop it before pushing a public repo.
- `bin/baseline` uses port 4002 for the cold run; it fails if something else holds it.

## Interfaces
```
bin/baseline [RUNS]                       # writes bench/baseline.json; env BASELINE_OUT, PGHOST, PGPORT
mix cook.bench [--runs N] [--baseline PATH] [--out PATH]   # daemon must be running; writes bench/warm.json
```
`bench/baseline.json`: `schema, recorded_at, commit, app, command, runs_count, total_ms, phases_ms{checkout,
deps_fetch, npm_install, browser_install, compile, assets_build, db_setup, test}, tests, aggregate, machine,
caveats[], runs[{run, total_ms, phases_ms, failed_phases, tests, failures, test_exit_code, test_status}]`.
`bench/warm.json`: `schema, recorded_at, command, percentile_method, baseline{file,total_ms,recorded_at},
machine, summary{runs, verdicts{pass,fail,error}, wall_ms, duration_ms, first_test_ms, start_to_first_test_ms
(each {count, missing, min, p50, p95, max}), baseline_total_ms, speedup_p50, speedup_p95},
runs[{run, wall_ms, exit_code, status, duration_ms, first_test_ms, overhead_ms, selected, failures, error}]`.
```elixir
Cook.Bench.Stats.percentile(samples, p) | summarize(samples) | speedup(baseline_ms, warm_ms)
Cook.Bench.Stats.verdict_counts(statuses) | report(rows, baseline_total_ms)
```
