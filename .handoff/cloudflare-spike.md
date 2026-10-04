# cloudflare-spike (can the hosted side of Cook run on Cloudflare Containers?)

## 2026-10-04

### Status
COMPLETE. Everything deployed was deleted. Short answer: yes, it works unmodified; it is about twice as slow as
this workstation at the same worker count.

### Done
All source is in `spike/cloudflare` (throwaway; nothing else was edited, `fixtures/react_app` untouched):
- `Dockerfile` + `Dockerfile.dockerignore`: `mcr.microsoft.com/playwright:v1.63.0-noble` (Node 24.20, Chromium 1243
  already inside) + `npm ci` of the fixture + the fixture's `src`, `e2e` and config files. Build context is the repo
  root (`image_build_context: "../.."`). Image is 3.84 GB locally (base is 3.56 GB), linux/amd64.
- `container/server.mjs`: control server on port 8080 inside the container (`/ping`, `/info`, `/mark`, `/prepare`, `/run`).
- `src/index.ts`: Worker + `Runner extends Container` (`@cloudflare/containers` 0.3.7). Every endpoint needs the
  header `x-spike-secret` (Wrangler secret `SPIKE_SECRET`; fails closed if the secret is unset).
- `wrangler.jsonc`: `instance_type: "standard-4"`, `max_instances: 2`, Durable Object declared with `exports`.
- `.gitignore` (`node_modules/`, `.wrangler/`, env files).

Raw Containers were chosen over the Sandbox SDK: the spike needs one long-lived process it controls over HTTP,
which is exactly `Container` + `defaultPort`. The Sandbox SDK would add its own control binary as entrypoint and an
image tag that must match the npm version; its exec/file API was not needed. The Sandbox Dockerfile page still shows
version 0.7.0 in its examples, although the research file says 1.0 was released, so it was not tested at all.

### Verified
Instance type obtained: `standard-4` (accepted without complaint). Inside: 4 CPUs ("AMD EPYC"), 12215 MiB RAM,
18 GB root disk (2.6 GB used), kernel `6.18.54-cloudflare-microvm`, running as root, location `cmh01`/`cmh02`.

**1. Does it work.** Yes. 15 full-suite runs on Cloudflare, 45 tests each:
11 runs 45/45; 3 runs 44/45 with only the `@flaky` test failing; 1 run 44/45 with a non-flaky failure
(`ticking a task marks it done`: `locator.check: Clicking the checkbox did not change its state`), which happened
on instance `a` while a second instance was running the suite at the same time.
Changes Chromium needed: none. No extra flags, no `--shm-size`, no sandbox setting, no memory setting. Chromium runs
as root with Playwright's defaults. `/dev/shm` does not exist as a path in the microVM (`ls: cannot access
'/dev/shm'`; `/proc/mounts` lists a 64 MB shm mount that a later devtmpfs mount on `/dev` hides). Free memory with
both servers up and after many runs: about 10.6 of 12.2 GiB.
The dev server's bind address (127.0.0.1) did not need changing because everything runs inside one instance.

**2. Cold** (one `POST /run {"workers":4}` to a stopped or new instance; client-side wall clock, ms):

| run | (a) instance answers | (b) dev + browser server ready | (c) first test starts | (d) suite finished | result |
|---|---|---|---|---|---|
| new instance, first ever | 866 | 3,150 | 4,940 | 35,251 | 45/45 |
| after kill | 1,898 | 5,009 | 6,932 | 40,421 | 45/45 |
| after kill + redeploy | 1,359 | 4,152 | 6,219 | 41,047 | 45/45 |
| second instance `b`, new | 1,123 | 3,754 | 5,706 | 37,301 | 45/45 |

(b) = (a) + `/prepare` time (2.3 to 3.1 s: Vite answers `/api/health` after 2.2 to 3.0 s, `playwright run-server`
listens after 1.2 to 1.7 s, started in parallel). (c) = (b) + 1.8 to 2.1 s of Playwright runner start-up.
Wake alone (`POST /wake`, `startAndWaitForPorts`): 743 ms, 1,268 ms. Container process uptime when the first request
arrived: 209 to 311 ms.
After the very first `wrangler deploy` the application was in state `provisioning` for about 3 minutes
(13:09:59 to 13:13:02) and requests got HTTP 503 "There is no Container instance available at this time".
Deploy itself: 71 s first time (push of 3.8 GB), 18 s second time.

**3. Warm** (instance awake, both servers running, client-side request-to-result, full suite):

| Playwright workers | ms | result |
|---|---|---|
| 4 | 30,450 / 30,766 / 31,509 / 30,149 / 28,943 | 45/45 x4, 44/45 (flaky) |
| 4, while another instance also ran | 31,369 | 44/45 (non-flaky failure above) |
| 4, no browser server (each worker launches Chromium) | 34,957 | 44/45 (flaky) |
| 2 (also Playwright's default here: half of 4 CPUs) | 40,990 / 42,673 | 45/45, 44/45 (flaky) |
| 3 | 33,669 | 45/45 |
| 6 | 29,252 | 45/45 |

Single file (`e2e/settings.spec.ts`, 3 tests, 3 workers used): 3,945 / 3,933 / 3,978 ms.
`e2e/home.spec.ts` (2 tests, 1 worker): 3,699 ms. Of those about 1.3 s is runner start-up before the first test.
Worker + Durable Object overhead per request: 110 to 200 ms.

**4. This workstation** (24 cores, load average about 10 from other agents' work, so noisy):
`npx playwright test --workers=4` against an already running dev server: 15,059 / 14,543 / 14,712 / 14,289 ms,
45 passed each time. An earlier batch of three runs was discarded: another agent's cleanup killed the dev server
during it (orchestrator confirmed).
Same image under local Docker with `--cpus=4 --memory=12g`: 4 workers 23,795 (first run) and 21,532 ms;
2 workers 24,130 ms; 8 workers 27,290 ms with one non-flaky timeout-type failure; single file 2,231 ms.

**5. After sleep.** Nothing is kept. A marker file written to `/app/data` was gone after the instance stopped
(both after `destroy()` and after the idle timeout), the dev server and browser server were gone, and the process
uptime was back to under 0.5 s. Time until tests can run again is the cold figure: first test about 5 to 7 s after
the request, full suite about 35 to 41 s. With `sleepAfter = '90s'`, after 170 s idle the next request took 1.46 s
and reached a fresh process (uptime 348 ms).

**6. Two instances at once.** Works with `max_instances: 2`: `a` (warm) finished in 31.4 s and `b` (cold) in 37.3 s,
started at the same moment, each with its own dev server, database and browser.

**7. Cost** (rates from `cloudflare-research.md`; standard-4 = 4 vCPU, 12 GiB, 20 GB disk):
- Awake and idle: 12 x $0.0000025 + 20 x $0.00000007 = $0.0000314/s = **$0.113 per hour**.
- Awake with all 4 vCPUs busy the whole hour: + 4 x $0.00002/s = $0.288, so **at most $0.40 per hour**.
- One warm full-suite run (about 30 s, load average about 4): about **$0.003**.
- This spike: about 27 instance-minutes awake (about $0.05) plus 15 full runs and a few single-file runs of CPU (at most $0.045):
  **about $0.10**, before any allowance included in the Workers Paid plan. About $0.02 of that was the 12 idle
  minutes caused by the SIGTERM problem under Gotchas. Estimate from the published rates, not from a bill.

**Auth and cleanup.** Without the header: 401; wrong value: 401. Deleted: `wrangler delete --name cook-cf-spike`,
`wrangler containers delete <id>`, `wrangler containers images delete` for both tags. Afterwards
`wrangler containers list` -> "No containers found.", `wrangler containers images list` -> empty, the Worker URL
returns 404. Local: test container and built image removed, no dev server on 4310. A grep of `spike/` and this file
for the secret, the account id and the workers.dev subdomain finds nothing.

### Unverified / assumptions
- Whether the 2x gap to the workstation is CPU speed alone. The suite is limited by one single-threaded Vite dev
  server (see react-fixture Gotchas), so per-core speed matters more than core count. A production build was not tried.
- Whether a smaller image (Chromium only, no Firefox/WebKit) starts faster. Cold start was already about 1 to 2 s
  with the 3.8 GB image, so image pull did not seem to be on the request path, but only four cold starts were measured,
  all within 30 minutes of a deploy and in one location.
- Cold start after a long sleep (hours) or in another region. Longest idle before a wake was about 3 minutes.
- Sandbox SDK, filesystem snapshots (would be the way to keep `node_modules` or a warm Vite cache across sleep),
  and the `durable_object` scheduling policy mentioned in the research file: not tried. The scheduling docs page
  named there returned 404.
- The cause of the one non-flaky failure. It was seen once in 15 runs, during the concurrent run; the fixture had 0
  such failures in 30 local runs. Looks like a click landing before hydration finished on a slower CPU; not proven.
- More than 2 concurrent instances, and the account's real concurrency limits.
- Actual billing, and what the Workers Paid plan includes.
- Custom instance types larger than standard-4 were not requested (documented maximum is 4 vCPU / 12 GiB).
- Running the tests from outside the instance (browser in the container, runner on the developer's machine through
  a WebSocket) was not tried; only runner, browser and app together in one instance.

### Not done / next steps
1. Decide whether about 30 s per full run (vs 14.5 s here at 4 workers, 10.9 s at 12) is acceptable for the hosted
   side; if not, try a production build of the app in the instance, and several instances each running a shard.
2. If going ahead: try snapshots for keeping installed dependencies, and measure restore time.
3. Slim the image to Chromium only and re-measure cold start and deploy time.

### Gotchas
- **The container's PID 1 must handle SIGTERM.** `Container.stop()` and the `sleepAfter` timeout both send SIGTERM.
  A bare `node server.mjs` as PID 1 ignores it, so the instance never slept: it was still running (and billing)
  12.5 minutes after a 3 minute `sleepAfter`, and `stop()` returned success with nothing happening. After adding a
  SIGTERM handler the idle timeout worked. `destroy()` (SIGKILL) always works.
- `getState()` is not a reliable view: it said `healthy` while `wrangler containers instances` showed the instance
  `inactive`, and the reverse right after a wake. The control-plane listing lags too.
- After a redeploy, instances that are already running keep the old image; so did instance `a` after `destroy()`
  and restart about a minute after the deploy, and a brand new instance `b`. The new image was only picked up a
  couple of minutes later. Check what is actually running (the spike's `/info`) before trusting a measurement.
- First deploy: about 3 minutes of 503s while the application is `provisioning`.
- Playwright's default worker count in the instance is 2 (half of 4 CPUs), which is the slowest setting measured.
  Pass `--workers=4` (6 was no better than 4 within noise).
- Wrangler config now declares the Durable Object under `exports` (`{"type": "durable-object", "storage": "sqlite"}`)
  instead of `migrations`; wrangler 4.147.0 accepted it.
- `wrangler deploy` runs `docker login registry.cloudflare.com` and stores that credential in
  `~/.docker/config.json` (outside the repo). It was left there.
- A build context outside the Worker directory works with `image_build_context` plus a `Dockerfile.dockerignore`
  next to the Dockerfile (BuildKit); no `.dockerignore` at the repo root was needed.
- npm blocked workerd's postinstall script on this machine; `wrangler deploy` still worked. `wrangler dev` was not tried.
- The base image `mcr.microsoft.com/playwright:v1.63.0-noble` (3.56 GB) is still in the local Docker cache.

### Interfaces
Nothing later stages should depend on; the code is a throwaway. To repeat the experiment from `spike/cloudflare`:
- `npm install`, then `npx wrangler deploy` (Docker must be running), then
  `openssl rand -hex 32 | npx wrangler secret put SPIKE_SECRET` (keep the value outside the repo).
- Every call: header `x-spike-secret: <secret>`, optional `?instance=<name>` (default `a`), base `<worker-url>`.
  - `GET /state`, `POST /wake`, `POST /stop`, `POST /destroy` (handled by the Worker).
  - `POST /prepare` starts the dev server (4310) and `playwright run-server` (9323) in the instance.
  - `POST /run` with JSON `{"workers": 4, "files": ["e2e/settings.spec.ts"], "connect": true, "grep": "@slow"}`
    (all optional) runs `npx playwright test --reporter=json --retries=0 ...` and returns `{summary}`;
    `/run?full=1` also returns Playwright's JSON report. It calls `/prepare` itself if needed.
  - `GET /info` (CPU, memory, mounts, processes), `POST /mark` (writes a marker file for the persistence check).
- Delete: `npx wrangler delete --name cook-cf-spike --force`, `npx wrangler containers list` then
  `npx wrangler containers delete <id>`, `npx wrangler containers images list` then
  `npx wrangler containers images delete cook-cf-spike-runner:<tag>`.
