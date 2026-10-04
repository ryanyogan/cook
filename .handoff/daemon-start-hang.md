# Stage: daemon-start-hang (2026-10-04)

## Status
COMPLETE.

## Done
Cause (observed, not inferred): `Cook.Pool.Distribution` made the daemon's cookie with
`Base.url_encode64`, whose alphabet contains `-`. The cookie goes to the app instance as
`elixir --cookie COOKIE`, which becomes `erl -setcookie COOKIE`. `erl` reads an argument that starts
with `-` (or `+`) as a flag, so a cookie with a leading `-` is dropped without any message. The
instance then boots with the cookie from `~/.erlang.cookie`, prints its ready marker, and rejects
Cook's handshake ("Connection attempt from node ... rejected. Invalid challenge reply" in its
output). `true = Node.connect(node)` fails with `{:badmatch, false}`. The cookie lives as long as the
daemon, so every reboot of the instance fails the same way: that is why it stayed down until the
run's 120 s wait ran out, and why it looked random (1 start in 64 on average; it has nothing to do
with `bin/cook stop`, epmd, name reuse or timing).

Ruled out by the same evidence: epmd registration race, stale node names, a previous instance still
alive, hostname resolution. In 300 cycles no start failed for any other reason.

Changes:
- `lib/cook/pool/distribution.ex`: `random_cookie/0` (now public) returns 32 hex digits.
  New `cookie_usable?/1` and `check_cookie/1`. `ensure_started/0` returns
  `{:error, {:unusable_cookie, message}}` when the VM was started with its own node name and a cookie
  that `erl` would drop; `Cook.Pool.Supervisor` already raises on an error there, so the daemon
  refuses to start instead of hanging.
- `lib/cook/pool/app_instance.ex`: `attach/1` no longer pattern-matches on `Node.connect/1`. A refused
  connection is `{:down, {:boot_failed, {:node_connect_failed, node}}}`; an unusable cookie is
  `{:down, {:boot_failed, {:unusable_cookie, message}}}`. No connect retry was added: the failure was
  never a timing problem.
- `bin/cook` (`start --detach`): stops waiting when waiting cannot help. Exit 2 at once with the last
  15 log lines if the daemon process exited; exit 2 with the logged reason once the instance has
  failed to boot three times (the daemon keeps running and retrying, as designed). The
  `COOK_START_TIMEOUT` deadline is unchanged for everything else.
- `test/cook/pool/commands_test.exs`: three unit tests for the cookie functions.
- `artifacts/daemon-start-hang/` (git-ignored): `loop.sh`, `stats.sh`, `force.sh`, `before.csv`,
  `after.csv`, and the daemon log of failed cycle 26.

## Verified
- Probe outside Cook: `elixir --sname t --cookie -AbCdEf_123 -e 'IO.inspect(Node.get_cookie())'` printed
  the `~/.erlang.cookie` value, not the one passed. Same for a leading `+`. `ab-c+d` was kept.
- Forced reproduction on the old code: set the running daemon's cookie to `-ForcedDashCookie123` over
  distribution, killed the instance. Result: `{:boot_failed, {:error, {:badmatch, false}}}` on every
  reboot (backoff 2, 4, 8 s ...), with "Invalid challenge reply" in the instance output. Same message
  as the original report.
- Loop on the old code, `loop.sh 150 before.csv` (each cycle: `COOK_START_TIMEOUT=25 bin/cook start
  --detach`, record, `bin/cook stop`): 150 cycles, **2 failed** (cycles 26 and 61). Those two were the
  only cycles whose cookie started with `-`, and both logged `{:badmatch, false}`. The 148 good cycles:
  `start --detach` wall time p50 1751 ms, p95 1980, max 2204; instance boot (from the log) p50 600 ms,
  max 780.
- Loop on the fixed code, `loop.sh 150 after.csv`: 150 cycles, **0 failed**, 0 cookies starting with
  `-` or `+`. `start --detach` p50 1748 ms, p95 2001, max 2232; instance boot p50 603 ms, max 898.
- Forced `-` cookie on the fixed code: the instance reports `{:boot_failed, {:unusable_cookie, "..."}}`
  with the explanation in the log (it cannot become ready in that state; the point is the reason).
- `bin/cook start --detach` with port 4040 taken: exit 2 in 1.2 s with `:eaddrinuse` shown
  (before: waited 180 s).
- `ELIXIR_ERL_OPTIONS="-sname cookdup" bin/cook start --detach` (instance exits with 1 on every boot):
  exit 2 in 4.5 s, message `Cook instance for ... is down ({:exited, 1})`.
- `mix precommit`: 112 passed (1 doctest, 111 tests), no warnings, no format changes.
- After finishing: `bin/cook stop` done, `epmd -kill` done, `pgrep -a "beam.smp|epmd"` and
  `pgrep -af "port_wrapper|run-server|cook_app_|phx.server"` print nothing, port 4040 does not answer.

## Unverified / assumptions
- That the original 1 in 15 incident was this cause. The error term and the "kept returning false"
  behaviour match exactly, and it is the only failure seen in 300 cycles, but that daemon's cookie was
  not recorded.
- The `ensure_started/0` branch for a VM started with its own node name and a `-` cookie is covered by
  the unit tests of `check_cookie/1` only. It was not run end to end (such a cookie can only come
  from `~/.erlang.cookie` or `Node.set_cookie/1`).
- The CI workflow was not run.

## Not done / next steps
1. A run that arrives while the instance keeps failing to boot still waits the full
   `ready_timeout_ms` (120 s) in `Cook.Runs.Runner.await_pool/3`, then reports `pool_not_ready`.
   `Runner.readiness/2` treats `{:down, reason}` as "wait". Making it give up after repeated
   `{:down, {:boot_failed, _}}` belongs to the runs stage and was left alone (brief: stay inside the
   pool and daemon start code). With the cookie fixed there is no known way to get into that state
   other than an app that cannot boot.
2. `/api/status` shows a down instance as just `down` (`Cook.Runs.status_text/1` drops the reason).
   `bin/cook start` therefore reads the reason from `tmp/cook.log`. Exposing the reason in the status
   JSON would be cleaner; also runs-stage code.
3. README does not mention the two new early exits of `start --detach`.

## Gotchas
- `erl` drops any flag value that starts with `-` or `+`, silently. Never put generated secrets or
  names on an `erl`/`elixir` command line unless their first character is controlled.
- The cookie is visible in `ps` output (`--cookie ...`), as before. `loop.sh` reads it from there.
- `pkill -f PATTERN` from a shell whose own command line contains PATTERN kills that shell. `force.sh`
  must be run as a file, not pasted.
- `bin/cook start --detach` counts `Cook instance for ... is down (` lines in `tmp/cook.log`. If that
  log message in `AppInstance.restart/2` is reworded, update the grep in `bin/cook`.
- A daemon start is about 1.75 s and an instance boot about 0.6 s on this machine, so a 150-cycle
  loop takes about 6 minutes.

## Interfaces
- `Cook.Pool.Distribution.random_cookie/0 :: atom` (32 hex digits),
  `cookie_usable?/1 :: boolean`, `check_cookie/1 :: :ok | {:error, {:unusable_cookie, String.t()}}`.
- `Cook.Pool.Distribution.ensure_started/0` can now also return `{:error, {:unusable_cookie, message}}`.
- New instance status reasons: `{:down, {:boot_failed, {:node_connect_failed, node}}}` and
  `{:down, {:boot_failed, {:unusable_cookie, message}}}`.
- `bin/cook start --detach` exits 2 early when the daemon process exits or after three failed
  instance boots; messages go to stderr.
- `artifacts/daemon-start-hang/loop.sh CYCLES OUT.csv` then `stats.sh OUT.csv`. CSV columns:
  `cycle,result,start_ms,instance_boot_ms,cookie_first_char,reason`.
