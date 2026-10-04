import { readFileSync } from "node:fs"
import { Deferred, Effect, Fiber } from "effect"
import { expect, test } from "vitest"
import type { ServerSnapshot } from "../src/Classify.ts"
import { type CoordinatorDeps, identities, makeCoordinator, type RanSuite } from "../src/Coordinator.ts"
import { ProjectError } from "../src/errors.ts"
import type { PlaywrightReport } from "../src/Runner.ts"
import { openStore } from "../src/Store.ts"

const failedReport = JSON.parse(
  readFileSync(new URL("./fixtures/report-failed.json", import.meta.url), "utf8"),
) as PlaywrightReport

let nextRun = 0
const ran = (over: Partial<RanSuite> = {}): RanSuite => ({
  runId: `run-${++nextRun}`,
  runDir: "/nowhere",
  exitCode: 1,
  report: failedReport,
  timings: {
    poolWaitMs: 0,
    spawnToBeginMs: 1,
    spawnToFirstTestMs: 2,
    spawnToEndMs: 3,
    spawnToExitMs: 4,
    totalMs: 5,
  },
  pool: {
    cold: false,
    browserServer: {
      info: { playwrightVersion: "1.63.0", wsEndpoint: "ws://127.0.0.1:1/", port: 1 },
      pid: 10,
      startMs: 5,
      starts: 1,
    },
    webServers: [
      {
        info: { name: "webServer[0]", command: "npm run dev", adopted: false },
        pid: 20,
        startMs: 5,
        starts: 1,
      },
    ],
  },
  ...over,
})

const healthy = (): ReadonlyArray<ServerSnapshot> =>
  identities(ran().pool).map((identity) => ({ ...identity, state: "ready", accepting: true }))

const deps = (over: Partial<CoordinatorDeps> = {}): CoordinatorDeps => ({
  run: () => Effect.succeed(ran()),
  snapshot: () => Effect.succeed(healthy()),
  store: openStore(":memory:"),
  ...over,
})

test("one run at a time per project path: the second waits, another path does not", async () => {
  const order: Array<string> = []
  await Effect.runPromise(
    Effect.gen(function* () {
      const gates = new Map<string, Deferred.Deferred<void>>()
      for (const name of ["a1", "a2", "b1"]) gates.set(name, yield* Deferred.make<void>())
      const coordinator = makeCoordinator(
        deps({
          run: (_spec, options) =>
            Effect.gen(function* () {
              const name = options.files?.[0] ?? ""
              order.push(`start ${name}`)
              yield* Deferred.await(gates.get(name) as Deferred.Deferred<void>)
              order.push(`end ${name}`)
              return ran()
            }),
        }),
      )
      const open = (name: string) => Deferred.succeed(gates.get(name) as Deferred.Deferred<void>, undefined)
      const a1 = yield* Effect.forkChild(coordinator.run({ path: "/proj/a", files: ["a1"] }))
      yield* Effect.sleep("20 millis")
      const a2 = yield* Effect.forkChild(coordinator.run({ path: "/proj/a", files: ["a2"] }))
      const b1 = yield* Effect.forkChild(coordinator.run({ path: "/proj/b", files: ["b1"] }))
      yield* Effect.sleep("40 millis")
      // a2 has not started: a1 holds the project. b1 runs alongside.
      expect(order).toEqual(["start a1", "start b1"])
      expect(yield* coordinator.status).toMatchObject([
        { path: "/proj/a", running: true, queued: 1 },
        { path: "/proj/b", running: true, queued: 0 },
      ])
      yield* open("a1")
      yield* open("a2")
      yield* open("b1")
      const verdicts = yield* Fiber.joinAll([a1, a2, b1])
      expect(order.slice(0, 2)).toEqual(["start a1", "start b1"])
      expect(order.indexOf("start a2")).toBeGreaterThan(order.indexOf("end a1"))
      expect(verdicts[1]?.timing.queue_ms).toBeGreaterThanOrEqual(30)
      expect(verdicts[0]?.timing.queue_ms).toBeLessThan(20)
      expect(yield* coordinator.status).toMatchObject([
        { path: "/proj/a", running: false, queued: 0 },
        { path: "/proj/b", running: false, queued: 0 },
      ])
    }),
  )
})

test("a caller that gives up while queued leaves the queue; the project is not left locked", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const coordinator = makeCoordinator(deps({ run: () => Effect.as(Deferred.await(gate), ran()) }))
      const first = yield* Effect.forkChild(coordinator.run({ path: "/proj/a" }))
      yield* Effect.sleep("10 millis")
      const second = yield* Effect.forkChild(coordinator.run({ path: "/proj/a" }))
      yield* Effect.sleep("10 millis")
      yield* Fiber.interrupt(second)
      expect(yield* coordinator.status).toMatchObject([{ running: true, queued: 0 }])
      yield* Fiber.interrupt(first)
      expect(yield* coordinator.status).toMatchObject([{ running: false, queued: 0 }])
      yield* Deferred.succeed(gate, undefined)
      expect((yield* coordinator.run({ path: "/proj/a" })).status).toBe("fail")
    }),
  )
})

test("failures with a healthy pool are a fail verdict, stored with every test result", async () => {
  const store = openStore(":memory:")
  const coordinator = makeCoordinator(deps({ store }))
  const verdict = await Effect.runPromise(
    coordinator.run({ path: "/proj/a", env: { PORT: "4999" }, clientStartedMs: Date.now() - 30 }),
  )
  expect(verdict.status).toBe("fail")
  expect(verdict.failures.map((f) => f.repro)).toEqual([
    "cook run /proj/a --env PORT=4999 e2e/estimate.spec.ts:6",
  ])
  expect(verdict.timing.client_ms).toBeGreaterThanOrEqual(30)
  expect(store.testResults(verdict.run_id).map((t) => t.status)).toEqual(["failed", "passed", "passed"])
  expect(store.recent(5).map((r) => [r.id, r.status])).toEqual([[verdict.run_id, "fail"]])
})

test("the same failures with a dead browser server are an error that names it, whatever the pool has noticed", async () => {
  // The runner returned ordinary-looking failures. What decides is the pool at the end of the run.
  const cases: ReadonlyArray<[string, (s: ServerSnapshot) => ServerSnapshot]> = [
    // Exit not noticed yet: still listed as ready with the old pid, but the port is closed.
    ["not accepting at run end", (s) => ({ ...s, accepting: false })],
    // Exit noticed, restart under way.
    ["not ready at run end", (s) => ({ ...s, state: "starting", pid: null, starts: null, accepting: false })],
    // Already restarted and healthy.
    ["restarted during run", (s) => ({ ...s, pid: 99, starts: 2 })],
  ]
  for (const [why, change] of cases) {
    const store = openStore(":memory:")
    let runs = 0
    const coordinator = makeCoordinator(
      deps({
        store,
        settleTimeoutMs: 0,
        run: () => Effect.sync(() => ran({ runId: `dead-${++runs}` })),
        // Healthy before the run, changed after it.
        snapshot: () =>
          Effect.sync(() => healthy().map((s) => (runs > 0 && s.kind === "browser_server" ? change(s) : s))),
      }),
    )
    const verdict = await Effect.runPromise(coordinator.run({ path: "/proj/a" }))
    expect(verdict.status).toBe("error")
    expect(verdict.error?.reason).toBe("browser_server_down")
    expect(verdict.error?.message).toContain(
      `browser server (Playwright 1.63.0) died during the run (${why})`,
    )
    expect(verdict.failures).toEqual([])
    // The run and what the runner reported are still stored, under an error run.
    expect(store.recent(1)[0]).toMatchObject({ status: "error", error_reason: "browser_server_down" })
    expect(store.testResults(verdict.run_id)).toHaveLength(3)
  }
})

test("a dead web server is named with its command", async () => {
  let runs = 0
  const coordinator = makeCoordinator(
    deps({
      run: () => Effect.sync(() => ran({ runId: `web-${++runs}` })),
      snapshot: () =>
        Effect.sync(() =>
          healthy().map((s) => (runs > 0 && s.kind === "web_server" ? { ...s, pid: 21, starts: 2 } : s)),
        ),
    }),
  )
  const verdict = await Effect.runPromise(coordinator.run({ path: "/proj/a" }))
  expect(verdict.error).toMatchObject({ reason: "web_server_down" })
  expect(verdict.error?.message).toContain("web server webServer[0] (`npm run dev`) died during the run")
})

test("a run waits for the pool to notice a dead server before it starts", async () => {
  let snapshots = 0
  let startedAfter = -1
  const coordinator = makeCoordinator(
    deps({
      run: () =>
        Effect.sync(() => {
          startedAfter = snapshots
          return ran({ exitCode: 0 })
        }),
      // The first three looks show a ready server with a closed port.
      snapshot: () => Effect.sync(() => healthy().map((s) => ({ ...s, accepting: ++snapshots > 6 }))),
    }),
  )
  await Effect.runPromise(coordinator.run({ path: "/proj/a" }))
  expect(startedAfter).toBeGreaterThanOrEqual(6)
})

test("errors of the engine and a run that takes too long become error verdicts", async () => {
  const refused = makeCoordinator(
    deps({
      run: () => Effect.fail(new ProjectError({ path: "/proj/x", reason: "no Playwright config found" })),
    }),
  )
  const verdict = await Effect.runPromise(refused.run({ path: "/proj/x" }))
  expect(verdict.error).toEqual({ reason: "unknown_project", message: "/proj/x: no Playwright config found" })

  const slow = makeCoordinator(
    deps({ runTimeoutMs: 30, run: () => Effect.as(Effect.sleep("5 seconds"), ran()) }),
  )
  expect((await Effect.runPromise(slow.run({ path: "/proj/a" }))).error?.reason).toBe("run_timeout")

  const broken = makeCoordinator(deps({ run: () => Effect.die(new Error("bug")) }))
  const unexpected = await Effect.runPromise(broken.run({ path: "/proj/a" }))
  expect(unexpected.error?.reason).toBe("unexpected")
  expect(unexpected.error?.message).toContain("bug")
})
