import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Context, Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { BrowserServer, type BrowserServerInfo } from "./BrowserServer.ts"
import type { ServeRequest } from "./Build.ts"
import { type CookError, RunError } from "./errors.ts"
import { cookHome } from "./os.ts"
import { type ProjectSpec, resolveProject } from "./Project.ts"
import { type Ready, spawnGuarded } from "./Supervised.ts"
import { type Serving, WebServer, type WebServers } from "./WebServer.ts"

const reporterScript = fileURLToPath(new URL("../assets/reporter.cjs", import.meta.url))

export const defaultTestTimeoutMs = 10_000

export interface RunOptions {
  /** Playwright test filters: files or `file:line`, as given to `playwright test`. Default: all. */
  readonly files?: ReadonlyArray<string>
  /** Cap per test in milliseconds (`--timeout`). Default 10 000. */
  readonly testTimeoutMs?: number
  /** `--workers`. Default: the project's own setting. */
  readonly workers?: number | string
  /** Further `playwright test` arguments, appended as given (for example `--grep`, `@tag`). */
  readonly extraArgs?: ReadonlyArray<string>
  /** `--trace`. Default: the project's own setting. */
  readonly trace?: "on" | "off"
  /**
   * Recorded milliseconds by Cook test id. When given (and not empty) the slowest work is queued
   * first, through the reporter's `preprocess` hook (`assets/order.cjs`).
   */
  readonly durations?: ReadonlyMap<string, number>
  /** `dev` or `build` to force how the web servers are served; default `auto` (the project's file). */
  readonly serve?: ServeRequest
}

/** What the ordering hook did, as the reporter recorded it. */
export interface OrderOutcome {
  readonly applied: boolean
  /** Why nothing was reordered; null when it was. */
  readonly reason: string | null
  /** Selected tests with a recorded duration, and without one. */
  readonly estimated: number
  readonly unknown: number
  /** Files and tests that are not at their original position among their siblings. */
  readonly moved: number
}

/** The parts of Playwright's JSON report Cook names. The rest is passed through untouched. */
export interface PlaywrightReport {
  readonly config: Record<string, unknown>
  readonly suites: ReadonlyArray<unknown>
  readonly errors: ReadonlyArray<unknown>
  readonly stats: {
    readonly startTime: string
    readonly duration: number
    readonly expected: number
    readonly unexpected: number
    readonly flaky: number
    readonly skipped: number
  }
}

export interface RunTimings {
  /** Call to both servers ready (includes resolving the project). Near zero on a warm pool. */
  readonly poolWaitMs: number
  /** Runner spawn to Playwright's `onBegin`: config and test files loaded. Null if never reached. */
  readonly spawnToBeginMs: number | null
  /** Runner spawn to the first test starting in a worker. Null if no test started. */
  readonly spawnToFirstTestMs: number | null
  /** Runner spawn to Playwright's `onEnd`. Null if never reached. */
  readonly spawnToEndMs: number | null
  /** Runner spawn to the runner process having exited. */
  readonly spawnToExitMs: number
  /** The whole call. */
  readonly totalMs: number
}

export interface RunResult {
  readonly runId: string
  /** Directory with `report.json`, `events.json` and `output.log` of this run. */
  readonly runDir: string
  /** Exit code of `playwright test`: 0 all passed, 1 failures; anything else is not a test result. */
  readonly exitCode: number
  /** Playwright's JSON report as written, or null when the runner left none. */
  readonly report: PlaywrightReport | null
  readonly timings: RunTimings
  readonly tests: number | null
  readonly workers: number | null
  /** Null when no durations were given, or the installed Playwright has no `preprocess` hook. */
  readonly order: OrderOutcome | null
  /** How the web servers were served, and what the freshness check, build and restart cost. */
  readonly serving: Serving
  /** The command that was run, for the record. */
  readonly command: ReadonlyArray<string>
  readonly pool: {
    /** True when a server had to be started or awaited inside this call: overhead, a pool bug. */
    readonly cold: boolean
    readonly browserServer: Ready<BrowserServerInfo>
    readonly webServers: WebServers["servers"]
  }
}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

interface Events {
  readonly beginAt: number | null
  readonly firstTestAt: number | null
  readonly endAt: number | null
  readonly tests: number | null
  readonly workers: number | null
  readonly order: OrderOutcome | null
}

/** Arguments for the project's `playwright test`. Pure, so it is unit tested. */
export const runnerArgs = (config: string, options: RunOptions = {}): ReadonlyArray<string> => [
  "test",
  "--config",
  config,
  "--retries=0",
  `--timeout=${options.testTimeoutMs ?? defaultTestTimeoutMs}`,
  `--reporter=${reporterScript},json`,
  ...(options.workers !== undefined ? [`--workers=${options.workers}`] : []),
  ...(options.trace !== undefined ? [`--trace=${options.trace}`] : []),
  ...(options.extraArgs ?? []),
  ...(options.files ?? []),
]

export const timingsFrom = (
  marks: { readonly calledAt: number; readonly spawnedAt: number; readonly exitedAt: number },
  events: Partial<Events> | null,
  doneAt: number,
): RunTimings => {
  const since = (at: number | null | undefined) => (typeof at === "number" ? at - marks.spawnedAt : null)
  return {
    poolWaitMs: marks.spawnedAt - marks.calledAt,
    spawnToBeginMs: since(events?.beginAt),
    spawnToFirstTestMs: since(events?.firstTestAt),
    spawnToEndMs: since(events?.endAt),
    spawnToExitMs: marks.exitedAt - marks.spawnedAt,
    totalMs: doneAt - marks.calledAt,
  }
}

/** Runs a project's suite with the project's own `playwright test` against the warm pool. */
export class Runner extends Context.Service<
  Runner,
  {
    readonly run: (spec: ProjectSpec, options?: RunOptions) => Effect.Effect<RunResult, CookError>
  }
>()("cook/Runner") {
  static readonly layer = Layer.effect(
    Runner,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const browserServer = yield* BrowserServer
      const webServer = yield* WebServer

      const run = (spec: ProjectSpec, options: RunOptions = {}) =>
        Effect.scoped(
          Effect.gen(function* () {
            const calledAt = Date.now()
            const project = yield* resolveProject(spec)
            const [browser, web] = yield* Effect.all(
              [
                browserServer.ensure(project),
                webServer.ensure(project, options.serve !== undefined ? { serve: options.serve } : {}),
              ],
              { concurrency: 2 },
            )
            const runId = randomUUID()
            const runDir = cookHome("runs", runId)
            const reportFile = join(runDir, "report.json")
            const eventsFile = join(runDir, "events.json")
            const logFile = join(runDir, "output.log")
            const orderFile = join(runDir, "order.json")
            const ordered = options.durations !== undefined && options.durations.size > 0
            if (ordered) {
              mkdirSync(runDir, { recursive: true })
              writeFileSync(orderFile, JSON.stringify(Object.fromEntries(options.durations ?? [])))
            }
            // The project's file may name the best worker count for the mode; the caller's wins.
            const workers = options.workers ?? web.workers
            const args = [
              project.playwrightCli,
              ...runnerArgs(web.config, { ...options, ...(workers !== undefined ? { workers } : {}) }),
            ]
            const spawnedAt = Date.now()
            const handle = yield* spawnGuarded(
              spawner,
              {
                command: process.execPath,
                args,
                cwd: project.configDir,
                env: {
                  ...process.env,
                  ...project.env,
                  ...web.runnerEnv,
                  PW_TEST_CONNECT_WS_ENDPOINT: browser.ready.info.wsEndpoint,
                  PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile,
                  PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile,
                  COOK_EVENTS_FILE: eventsFile,
                  // Always set, so a value inherited from the daemon's own environment cannot leak in.
                  COOK_ORDER_FILE: ordered ? orderFile : "",
                },
              },
              logFile,
            ).pipe(Effect.mapError((reason) => new RunError({ reason, logFile })))
            const exitCode = yield* handle.exitCode.pipe(
              Effect.mapError((error) => new RunError({ reason: error.message, logFile })),
            )
            const exitedAt = Date.now()
            const events = readJson(eventsFile) as Partial<Events> | null
            const report = readJson(reportFile) as PlaywrightReport | null
            return {
              runId,
              runDir,
              exitCode: Number(exitCode),
              report,
              timings: timingsFrom({ calledAt, spawnedAt, exitedAt }, events, Date.now()),
              tests: events?.tests ?? null,
              workers: events?.workers ?? null,
              order: events?.order ?? null,
              serving: web.serving,
              command: [process.execPath, ...args],
              pool: { cold: browser.cold || web.cold, browserServer: browser.ready, webServers: web.servers },
            } satisfies RunResult
          }),
        )

      return { run }
    }),
  )
}
