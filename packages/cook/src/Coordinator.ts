import { randomUUID } from "node:crypto"
import { copyFileSync, mkdirSync, realpathSync } from "node:fs"
import { join, resolve } from "node:path"
import { Cause, Context, Duration, Effect, Layer, Option, Semaphore } from "effect"
import { BrowserServer } from "./BrowserServer.ts"
import { classify, describeDeath, type ServerIdentity, type ServerSnapshot, staleReady } from "./Classify.ts"
import type { CookError } from "./errors.ts"
import { tcpAccepts } from "./os.ts"
import { type ProjectSpec, resolveProject } from "./Project.ts"
import { globalErrors, type TestRow, testRows } from "./Report.ts"
import { defaultTestTimeoutMs, Runner, type RunOptions, type RunResult } from "./Runner.ts"
import { type Store, StoreService } from "./StoreService.ts"
import { consoleErrorsFromTrace } from "./Trace.ts"
import { type Artifacts, buildVerdict, type Verdict } from "./Verdict.ts"
import { WebServer } from "./WebServer.ts"

export interface RunRequest {
  readonly path: string
  /** Files or `file:line`, relative to the directory of the Playwright config. Empty: everything. */
  readonly files?: ReadonlyArray<string>
  /** Per-test cap in milliseconds. Default 10 000. */
  readonly timeoutMs?: number
  readonly workers?: number | string
  readonly env?: Readonly<Record<string, string>>
  readonly config?: string
  /** Epoch milliseconds at which the client was invoked, for `timing.client_ms`. */
  readonly clientStartedMs?: number
}

/** What the coordinator needs from a finished run. */
export type RanSuite = Pick<RunResult, "runId" | "runDir" | "exitCode" | "report" | "timings" | "pool">

export interface CoordinatorDeps {
  readonly run: (spec: ProjectSpec, options: RunOptions) => Effect.Effect<RanSuite, CookError>
  /** The pooled servers of a project as they are right now. */
  readonly snapshot: (spec: ProjectSpec) => Effect.Effect<ReadonlyArray<ServerSnapshot>>
  readonly store: Store
  /** Gathers what Playwright kept for the failed tests into the run directory. */
  readonly collect?: (failed: ReadonlyArray<TestRow>, runDir: string) => ReadonlyMap<string, Artifacts>
  /** A run longer than this is abandoned with an `error` verdict. Default 15 minutes. */
  readonly runTimeoutMs?: number
  /** How long a run waits for the pool to notice a dead server before it starts anyway. */
  readonly settleTimeoutMs?: number
}

export interface ProjectState {
  readonly path: string
  readonly running: boolean
  /** Runs waiting for the running one. */
  readonly queued: number
  readonly servers: ReadonlyArray<ServerSnapshot>
}

export interface CoordinatorApi {
  /** Runs when no other run of the same project path is running; always ends with a verdict. */
  readonly run: (request: RunRequest) => Effect.Effect<Verdict>
  readonly status: Effect.Effect<ReadonlyArray<ProjectState>>
}

export const browserServerName = (playwrightVersion: string) =>
  `browser server (Playwright ${playwrightVersion})`

/** The servers a run started with, from what the runner was handed. */
export const identities = (pool: RanSuite["pool"]): ReadonlyArray<ServerIdentity> => [
  {
    kind: "browser_server",
    name: browserServerName(pool.browserServer.info.playwrightVersion),
    pid: pool.browserServer.pid,
    starts: pool.browserServer.starts,
  },
  ...pool.webServers.map(
    (server): ServerIdentity =>
      "pid" in server
        ? {
            kind: "web_server",
            name: server.info.name,
            pid: server.pid,
            starts: server.starts,
            detail: server.info.command,
          }
        : {
            kind: "web_server",
            name: server.info.name,
            pid: null,
            starts: null,
            detail: server.info.command,
          },
  ),
]

/** Copies the trace and error context of failed tests into the run directory and reads the trace. */
export const collectArtifacts = (
  failed: ReadonlyArray<TestRow>,
  runDir: string,
): ReadonlyMap<string, Artifacts> => {
  const found = new Map<string, Artifacts>()
  const dir = join(runDir, "artifacts")
  // The project's output directory is wiped by its next run, so keep our own copy.
  const keep = (source: string | null, name: string): string | null => {
    if (source === null) return null
    try {
      mkdirSync(dir, { recursive: true })
      const target = join(dir, name)
      copyFileSync(source, target)
      return target
    } catch {
      return null
    }
  }
  failed.forEach((row, index) => {
    const trace = keep(row.tracePath, `${index + 1}-trace.zip`)
    found.set(row.testId, {
      trace,
      consoleErrors: trace !== null ? consoleErrorsFromTrace(trace) : null,
      domSnapshot: keep(row.errorContextPath, `${index + 1}-error-context.md`),
    })
  })
  return found
}

const canonical = (path: string): string => {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

const reproPrefix = (path: string, request: RunRequest): string =>
  [
    "cook run",
    path,
    ...Object.entries(request.env ?? {}).map(([key, value]) => `--env ${key}=${value}`),
    ...(request.config !== undefined ? [`--config ${request.config}`] : []),
  ].join(" ")

const errorOf = (error: CookError): { reason: string; message: string } => {
  switch (error._tag) {
    case "ProjectError":
      return { reason: "unknown_project", message: `${error.path}: ${error.reason}` }
    case "PoolError":
      return {
        reason: "pool_not_ready",
        message: `${error.server}: ${error.reason}${error.logTail ? `\n${error.logTail}` : ""}`,
      }
    case "RunError":
      return {
        reason: "runner_crashed",
        message: `${error.reason}${error.logFile !== undefined ? ` (output in ${error.logFile})` : ""}`,
      }
  }
}

interface Entry {
  readonly lock: Semaphore.Semaphore
  running: boolean
  queued: number
  spec: ProjectSpec
}

export const makeCoordinator = (deps: CoordinatorDeps): CoordinatorApi => {
  const entries = new Map<string, Entry>()
  const collect = deps.collect ?? (() => new Map<string, Artifacts>())
  const runTimeout = Duration.millis(deps.runTimeoutMs ?? 15 * 60_000)
  const settleTimeoutMs = deps.settleTimeoutMs ?? 5000

  /**
   * A server that died a moment ago can still be listed as ready, because its exit has not been
   * noticed yet. A run started now would be handed a dead endpoint, so wait until the pool has
   * caught up (it then restarts the server and the runner waits for that as usual).
   */
  const settle = (spec: ProjectSpec) =>
    Effect.gen(function* () {
      const deadline = Date.now() + settleTimeoutMs
      while (staleReady(yield* deps.snapshot(spec)) && Date.now() < deadline) {
        yield* Effect.sleep("20 millis")
      }
    })

  const execute = (request: RunRequest, path: string, spec: ProjectSpec, receivedAt: number) =>
    Effect.gen(function* () {
      const queueMs = Date.now() - receivedAt
      const capMs = request.timeoutMs ?? defaultTestTimeoutMs
      const files = request.files ?? []
      const options: RunOptions = {
        files,
        testTimeoutMs: capMs,
        ...(request.workers !== undefined ? { workers: request.workers } : {}),
      }
      const base = {
        path,
        files,
        capMs,
        queueMs,
        clientMs:
          request.clientStartedMs !== undefined ? Math.round(receivedAt - request.clientStartedMs) : null,
        known: deps.store.knownTests(path),
        reproPrefix: reproPrefix(path, request),
      }
      yield* settle(spec)
      const outcome = yield* deps.run(spec, options).pipe(Effect.timeoutOption(runTimeout), Effect.result)
      // The state of the pool now, after the runner has exited, decides whether a server died.
      const after = yield* deps.snapshot(spec)

      let rows: ReadonlyArray<TestRow> = []
      let verdict: Verdict
      if (outcome._tag === "Failure") {
        verdict = buildVerdict({
          ...base,
          runId: randomUUID(),
          durationMs: Date.now() - receivedAt,
          timings: null,
          rows,
          runner: null,
          error: errorOf(outcome.failure),
        })
      } else if (Option.isNone(outcome.success)) {
        verdict = buildVerdict({
          ...base,
          runId: randomUUID(),
          durationMs: Date.now() - receivedAt,
          timings: null,
          rows,
          runner: null,
          error: {
            reason: "run_timeout",
            message: `The run was abandoned after ${Duration.toMillis(runTimeout)} ms.`,
          },
        })
      } else {
        const result = outcome.success.value
        const death = classify(identities(result.pool), after)
        rows = testRows(result.report)
        const failed = rows.filter((row) => row.status !== "passed" && row.status !== "skipped")
        const artifacts = death === null ? collect(failed, result.runDir) : new Map<string, Artifacts>()
        verdict = buildVerdict({
          ...base,
          runId: result.runId,
          durationMs: Date.now() - receivedAt,
          timings: result.timings,
          rows,
          artifacts,
          globalErrors: globalErrors(result.report),
          runner: {
            exitCode: result.exitCode,
            hasReport: result.report !== null,
            logFile: join(result.runDir, "output.log"),
          },
          error: death !== null ? { reason: death.reason, message: describeDeath(death) } : null,
        })
      }
      deps.store.record(verdict, rows, new Date(receivedAt))
      return verdict
    }).pipe(
      // Whatever goes wrong in here, the caller still gets a verdict.
      Effect.catchCause((cause) =>
        Effect.sync(() =>
          buildVerdict({
            runId: randomUUID(),
            path,
            files: request.files ?? [],
            capMs: request.timeoutMs ?? defaultTestTimeoutMs,
            durationMs: Date.now() - receivedAt,
            queueMs: 0,
            clientMs: null,
            timings: null,
            rows: [],
            runner: null,
            known: null,
            error: { reason: "unexpected", message: Cause.pretty(cause) },
            reproPrefix: reproPrefix(path, request),
          }),
        ),
      ),
    )

  const run = (request: RunRequest): Effect.Effect<Verdict> =>
    Effect.suspend(() => {
      const receivedAt = Date.now()
      const path = canonical(request.path)
      const spec: ProjectSpec = {
        path,
        ...(request.config !== undefined ? { config: request.config } : {}),
        ...(request.env !== undefined ? { env: request.env } : {}),
      }
      let entry = entries.get(path)
      if (entry === undefined) {
        entry = { lock: Semaphore.makeUnsafe(1), running: false, queued: 0, spec }
        entries.set(path, entry)
      }
      const mine = entry
      let waiting = true
      mine.queued += 1
      const leave = () => {
        if (waiting) mine.queued -= 1
        waiting = false
      }
      return Semaphore.withPermit(
        mine.lock,
        Effect.suspend(() => {
          leave()
          mine.running = true
          mine.spec = spec
          return execute(request, path, spec, receivedAt)
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              mine.running = false
            }),
          ),
        ),
      ).pipe(Effect.ensuring(Effect.sync(leave)))
    })

  const status = Effect.suspend(() =>
    Effect.forEach([...entries], ([path, entry]) =>
      Effect.map(deps.snapshot(entry.spec), (servers) => ({
        path,
        running: entry.running,
        queued: entry.queued,
        servers,
      })),
    ),
  )

  return { run, status }
}

/** The pooled servers of a project right now: its browser server and its web servers. */
export const poolSnapshot =
  (browserServer: BrowserServer["Service"], webServer: WebServer["Service"]) =>
  (spec: ProjectSpec): Effect.Effect<ReadonlyArray<ServerSnapshot>> =>
    Effect.gen(function* () {
      const project = yield* resolveProject(spec)
      const browsers = yield* browserServer.status
      const mine = browsers.filter((b) => b.playwrightVersion === project.playwrightVersion)
      const browserSnapshots = yield* Effect.forEach(mine, ({ playwrightVersion, status }) =>
        Effect.gen(function* () {
          const ready = status._tag === "ready" ? status.ready : null
          const accepting =
            ready !== null ? yield* Effect.promise(() => tcpAccepts("127.0.0.1", ready.info.port)) : false
          return {
            kind: "browser_server",
            name: browserServerName(playwrightVersion),
            pid: ready?.pid ?? null,
            starts: ready?.starts ?? null,
            state: status._tag,
            accepting,
          } satisfies ServerSnapshot
        }),
      )
      return [...browserSnapshots, ...(yield* webServer.snapshot(project))]
    }).pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<ServerSnapshot>>([])))

export class Coordinator extends Context.Service<Coordinator, CoordinatorApi>()("cook/Coordinator") {
  static readonly layer = Layer.effect(
    Coordinator,
    Effect.gen(function* () {
      const runner = yield* Runner
      const browserServer = yield* BrowserServer
      const webServer = yield* WebServer
      const store = yield* StoreService
      return makeCoordinator({
        run: (spec, options) => runner.run(spec, options),
        snapshot: poolSnapshot(browserServer, webServer),
        store,
        collect: collectArtifacts,
        ...(process.env.COOK_RUN_TIMEOUT_MS !== undefined
          ? { runTimeoutMs: Number(process.env.COOK_RUN_TIMEOUT_MS) }
          : {}),
      })
    }),
  )
}
