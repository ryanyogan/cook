# Stage 5: crash-classification (2026-10-04)

## Status
COMPLETE.

## Cause (confirmed)
CI run 37218846519 (commit `a3edfa3`), step "Kill the browser server mid-run": the step lasted 1.64 s, so the
verdict came about 0.14 s after the `kill -9`, with `status: fail`. The warm run just before took 10.0 s, so
the kill was mid-run.

`Cook.Runs.Runner.watched_run/4` took whichever message arrived first: the pool's result or the browser
server's `:DOWN`. Once node is dead every running test fails at once and every remaining test fails on
connect, so the whole run returns `{:ok, raw}` in tens of ms (locally 39 ms). The `:DOWN` needs the wrapper
shell to reap node and exit, the port to report `exit_status`, and the GenServer to stop. Whichever chain is
faster wins. Shards (more tests in flight, all failing together) made the result fast enough to win on the
runner.

Reproduced locally only with the window widened (temporary edits, removed):
- unfixed code + `Process.sleep(400)` in `BrowserServer`'s `exit_status` handler: kill at 1.5 s gave
  exit 1, `fail`, 34 failed / 10 passed, 1539 ms. Kill at 2.5 s gave `error` (the DOWN won that time).
- unfixed code without the delay: 8 kills, 8 `error` (DOWN arrives ~35 ms after the kill here). Not
  reproducible on this machine without widening.

App instance: no such race found. A killed instance makes `:erpc.call` raise, so the result itself is
`{:error, {:instance_down, _}}`. The end-of-run check now covers it as well.

## Done
- `lib/cook/runs/runner.ex`:
  - `identity(status, path)`: plain data from a pool status, `%{browser_server: %{pid, os_pid, up} | nil,
    instance: %{pid, node, generation, up} | nil}`.
  - `classify(result, before, after)`: pure. Browser server gone / replaced / not accepting turns `{:ok, _}`
    and `{:error, {:instance_down, _}}` into `{:error, {:browser_server_down, why}}`; instance gone /
    replaced / not ready turns `{:ok, _}` into `{:error, {:instance_down, why}}`; other errors are kept.
    `why` is `:gone_at_run_end | :not_up_at_run_end | :restarted_during_run | :not_up_at_run_start`.
  - `run/1` takes the identity from the status that made the pool `:ready`, and again after the pool
    returns (skipped when the monitor already reported the death). The monitor stays for fast abandonment.
  - `readiness/2` is `:wait` when the browser server's port is not accepting (dead node, exit not yet
    noticed), so the next run waits for the restart instead of erroring within 40 ms.
- `lib/cook/pool/browser_server.ex`: `status/1` adds `pid` (the GenServer) and `accepting` (fresh TCP probe
  of the port; false as soon as node is dead, independent of the port's exit notice).
- `lib/cook/pool/app_instance.ex`: `status/1` adds `pid` and `generation`.
- `test/cook/runs_test.exs`: `classify/3` and `identity/2` tests with plain data, readiness with a dead
  port, and one stub-pool run whose result is failures while the browser stopped accepting (no DOWN).
  `test/support/pool_stub.ex`: `put_browser/1`.
- Workflow `.github/workflows/ci.yml`: not changed (see Unverified).

## Verified
- `mix precommit`: exit 0, 109 passed (1 doctest, 108 tests).
- Real daemon, fixed code, no temporary edits. Kill = `kill -9` of the node `run-server` process after the
  sleep, then a recovery run. Flaky = `test/features/delivery_estimate_test.exs:8` only.

| target | sleep s | exit | status | reason | verdict ms | recovery |
|---|---|---|---|---|---|---|
| browser | 0.3 | 2 | error | browser_server_down | 341 | fail (flaky only) |
| browser | 1.0 | 2 | error | browser_server_down | 1038 | pass |
| browser | 1.5 | 2 | error | browser_server_down | 1539 | pass |
| browser | 2.5 | 2 | error | browser_server_down | 2535 | fail (flaky only) |
| browser | 4.0 | 2 | error | browser_server_down | 4028 | pass |
| browser | 0.6 | 2 | error | browser_server_down | 634 | pass |
| browser | 1.5 | 2 | error | browser_server_down | 1540 | pass |
| browser | 2.0 | 2 | error | browser_server_down | 2041 | pass |
| instance | 1.5 | 2 | error | app_instance_down | 1535 | pass |
| instance | 3.0 | 2 | error | app_instance_down | 3027 | pass |

- Fixed code with the race forced, so the result beats the DOWN every time (temporary edits, removed):
  - `Process.sleep(400)` in the `exit_status` handler, sleeps 0.3/1.0/1.5/2.5/4.0 and 0.6/1.5/2.0:
    8 of 8 exit 2 `browser_server_down` (`:gone_at_run_end`), 8 recoveries pass or flaky only.
  - `sleep 0.5` in `priv/pool/port_wrapper.sh` before it exits (the exit notice itself is late, the CI
    shape), sleeps 0.3/1.0/1.5/2.5/4.0: 5 of 5 exit 2 `browser_server_down` (`:not_up_at_run_end`, the TCP
    probe), 5 recoveries pass or flaky only. Before the `readiness/2` change the run right after the kill
    errored with `browser_server_down` in 40 ms; after it, it waits (ready_wait about 1.7 s).
- After the work: daemon stopped, epmd killed, no `run-server` node or instance beam left.

## Unverified / assumptions
- Not run on GitHub Actions: nothing was pushed. The fix is argued from the CI timing plus the forced-race
  runs above.
- Workflow step reviewed, no concrete problem found, so not changed: the run takes 10 s on the runner, far
  beyond the 1.5 s sleep; if `pgrep` matched nothing, `kill -9 ""` fails and the step fails loudly.
- `accepting` assumes the kernel closes node's listening socket when node dies. True for `kill -9` (seen in
  the wrapper-delay runs). A node that is alive but hung is not detected by this check.
- A Chromium crash with node still alive is not classified as `browser_server_down` (not in scope).

## Not done / next steps
1. Push and watch the e2e job.
2. Optional: a CI step that kills the instance beam (only the browser kill is in the workflow).

## Gotchas
- `Cook.Pool.status/0` now opens a TCP connection to the browser server port on every call (loopback,
  200 ms timeout, well under 1 ms normally). The runner polls it every 20 ms only while waiting for the pool.
- The post-run status call can block while a restarted `BrowserServer` is in `init` (about 1 s); it then
  returns the new pid and the run is `browser_server_down` (`:restarted_during_run`).
- `mix format` moves a trailing `# comment` onto its own line: a `sed '/MARK/d'` cleanup of a temporary line
  then leaves the code behind. Check `git diff` after removing temporary edits.
- Pids in `Cook.Pool.status/0` never reach JSON: `Cook.Runs.status/0` picks fields by name. Keep it so.

## Interfaces
```elixir
Cook.Runs.Runner.identity(pool_status, path)       # plain map, see Done
Cook.Runs.Runner.classify(result, before, after)   # {:ok, raw} | {:error, reason}
Cook.Pool.BrowserServer.status()                   # + pid, accepting
Cook.Pool.AppInstance.status(server)               # + pid, generation
Cook.PoolStub.put_browser(%{accepting: false})     # tests only; reset with %{}
```
`error.reason` values are unchanged (`browser_server_down`, `app_instance_down`); only `error.message` can
now carry the new `why` atoms.
