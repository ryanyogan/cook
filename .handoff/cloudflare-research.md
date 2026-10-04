# Cloudflare platform facts for Cook (researched 2026-10-04)

**Status**: COMPLETE (research only, no code). Decision on architecture is pending with the owner.

Read through a summarising fetch tool: re-open any figure before relying on it.
D = https://developers.cloudflare.com. "Not found" means no primary source confirmed it.

## Containers and Sandbox SDK
- GA on Workers Paid since 2026-04-13. Sandbox SDK 1.0 released 2026-09-30. Filesystem
  snapshots in public beta. (D/changelog/post/2026-04-13-containers-sandbox-ga/, D/changelog/product/sandbox/)
- linux/amd64 images in Firecracker microVMs, each instance fronted by a Durable Object.
  (D/containers/platform-details/architecture/)
- Sizes up to 4 vCPU / 12 GiB / 20 GB disk per instance; account limit 1,500 vCPU.
  (D/containers/platform-details/limits/)
- Cold start: docs "often 1-3 seconds"; Cloudflare blog reports median 648 ms, p99 1.129 s
  under the `durable_object` scheduling policy (https://blog.cloudflare.com/faster-agent-sandboxes/).
  A tutorial says a first request "can take about a minute".
- Lifetime: no fixed max, no uptime guarantee; default sleep after 10 min idle; sandbox
  inactivity timeout configurable up to 6 h. (D/containers/faq/, D/sandbox/concepts/lifetime/)
- Disk is ephemeral after sleep. Snapshots restore the root filesystem only, not memory or
  processes. Restore time: not found.
- Networking: reached through Worker -> Durable Object; WebSocket upgrades pass through.
  Direct inbound TCP: not documented. Outbound internet on by default.
- Pricing: $0.0000025/GiB-s memory and $0.00000007/GB-s disk as provisioned while running,
  $0.000020/vCPU-s for active CPU only; billing stops on sleep. (D/containers/pricing/)
- Placement by region (ENAM, WNAM, WEUR, ...), no datacenter pinning.
- Not found: Chromium inside a container, /dev/shm size; Chromium + dev server + Playwright
  runner in one instance; `wrangler dev`/workerd inside a container.

## Browser Run (was Browser Rendering)
- External access is a CDP endpoint (`connectOverCDP`); no Playwright-protocol endpoint was
  found, so `PW_TEST_CONNECT_WS_ENDPOINT` would not apply (inference).
- Inside Workers, "Playwright Test except Assertions" is not supported. (D/browser-run/playwright/)
- Idle timeout 60 s (extendable); 120-200 concurrent browsers (pages disagree); $0.09/browser-hour.

## Testing Workers apps
- `createTestHarness()` from Wrangler (2026-07-21) runs the production build locally; documented
  Playwright pattern: worker-scoped fixture, `baseURL` from `server.listen()`, `server.reset()`
  after each test (recreates local storage). Reset cost and parallel behaviour: not found.
  (D/workers/testing/test-harness/integrations/)
- Local dev (`wrangler dev`, Vite plugin) simulates KV/R2/D1/DO via Miniflare; D1 persists
  across runs.
- Worker Previews (2026-09-22): per-PR URL; DO namespaces provisioned automatically; KV, D1,
  R2 must be bound to separate resources by hand.
- D1 branching/cloning is not available yet; Time Travel restores in place.

## Control plane limits
- Durable Objects: SQLite 10 GB per object, alarms, WebSockets.
- Workflows: unlimited wall time per step, 50,000 concurrent instances.
- Queues: 5,000 msg/s per queue. D1: 10 GB per database.

## CI and agents on Cloudflare
- `@cloudflare/ci` (private beta, blog 2026-08-04): CI pipelines on Workflows with steps in
  Sandboxes; lint/typecheck/unit, no e2e mention.
- Several agent hosts run on Containers. No third-party report of Playwright Test suites
  running on Containers/Sandboxes was found.

## Orchestrator's reading (recommendation given to the owner, not yet decided)
- The engine has to run locally whatever happens (the worktree is on the developer's machine).
- Containers suit the hosted side: the same engine inside one instance next to the browser
  and the app. Needs a spike first, because Chromium-in-container is undocumented.
- Browser Run is not suitable as the test browser.
- Rewrite the engine in TypeScript so one codebase runs locally, in a Container, and beside
  a Workers control plane; freeze the Elixir version.
