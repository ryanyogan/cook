import { createHash } from "node:crypto"
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Context, Duration, Effect, Exit, Layer, Option, Scope, Semaphore } from "effect"
import { ChildProcessSpawner } from "effect/process"
import {
  type BuildRecord,
  buildKey,
  ConfigProblem,
  cookConfigName,
  decideFreshness,
  hashFile,
  loadCookConfig,
  parseBuildRecord,
  planServing,
  type ServeMode,
  type ServeRequest,
  type ServerPlan,
  type ServingPlan,
  scanFiles,
  scanOutputs,
  stampInputs,
  stampOutputs,
} from "./Build.ts"
import type { ServerSnapshot } from "./Classify.ts"
import { BuildError, PoolError } from "./errors.ts"
import { cookHome, portUsed, tail, tcpAccepts, urlAvailable } from "./os.ts"
import {
  type Project,
  parseWebServerDump,
  type WebServerEntry,
  wrapperPath,
  wrapperSource,
} from "./Project.ts"
import { type Ready, type Supervised, spawnGuarded, supervise } from "./Supervised.ts"

export interface WebServerInfo {
  readonly name: string
  readonly command: string
  /** What readiness was checked against; absent when the entry has neither url nor port. */
  readonly url?: string
  /** True when the server was already running and the entry allows reuse; Cook does not own it. */
  readonly adopted: boolean
  /** `dev`: the entry's own command. `build`: the project's build, served by its serve command. */
  readonly mode: ServeMode
}

/** How a run's web servers were served, and what keeping the build current cost. */
export interface Serving {
  readonly requested: ServeRequest
  /** Deciding whether the builds are current. Zero when no server is in build mode. */
  readonly checkMs: number
  /** Wall time of the build commands; null when nothing was built. */
  readonly buildMs: number | null
  /** Stopping the servers and starting them until ready; null when they were already running. */
  readonly restartMs: number | null
  readonly servers: ReadonlyArray<{
    readonly name: string
    readonly mode: ServeMode
    /** Why it was built in this run; null when the build was current or the mode is dev. */
    readonly rebuilt: string | null
  }>
}

export interface EnsureOptions {
  /** Default `auto`. */
  readonly serve?: ServeRequest
}

export interface WebServers {
  /** Config file to hand the runner: the project's config without `webServer`. */
  readonly config: string
  /** Environment the runner needs because `webServer` was removed from its config. */
  readonly runnerEnv: Readonly<Record<string, string>>
  readonly servers: ReadonlyArray<Ready<WebServerInfo> | { readonly info: WebServerInfo }>
  /** True when this call had to learn the entries or wait for a server to start. */
  readonly cold: boolean
  readonly serving: Serving
  /** `--workers` from the project's `cook.config.json` for the mode in effect, when it gives one. */
  readonly workers?: number | string
}

const probeFor = (entry: WebServerEntry): (() => Promise<boolean>) => {
  if (entry.url !== undefined) {
    const url = entry.url
    return () => urlAvailable(url)
  }
  if (entry.port !== undefined) {
    const port = entry.port
    return () => portUsed(port)
  }
  // Playwright treats an entry with nothing to wait for as ready once started.
  return async () => true
}

/**
 * Whether the entry's port accepts a TCP connection. Unlike the readiness probe this asks the
 * kernel, not the application, so a busy server is never mistaken for a dead one.
 */
export const acceptingFor = (entry: WebServerEntry): (() => Promise<boolean>) => {
  if (entry.url !== undefined) {
    try {
      const url = new URL(entry.url)
      const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80
      const host = url.hostname.replace(/^\[|\]$/g, "")
      return () => tcpAccepts(host, port)
    } catch {
      return async () => true
    }
  }
  if (entry.port !== undefined) {
    const port = entry.port
    return () => portUsed(port)
  }
  return async () => true
}

const nameOf = (entry: WebServerEntry, index: number) => entry.name ?? `webServer[${index}]`

const describe = (entry: WebServerEntry, index: number, plan: ServerPlan): WebServerInfo => ({
  name: nameOf(entry, index),
  command: plan.command,
  mode: plan.mode,
  ...(entry.url !== undefined
    ? { url: entry.url }
    : entry.port !== undefined
      ? { url: `http://localhost:${entry.port}` }
      : {}),
  adopted: false,
})

interface Learned {
  readonly configMtimeMs: number
  readonly envKey: string
  readonly entries: ReadonlyArray<WebServerEntry>
}

interface ProjectServers {
  readonly scope: Scope.Closeable
  /** The entries these servers were started from. */
  readonly learned: Learned
  /** `ServingPlan.key` of what is running. */
  readonly planKey: string
  readonly runnerEnv: Readonly<Record<string, string>>
  readonly servers: ReadonlyArray<
    (Supervised<WebServerInfo> & { readonly info: WebServerInfo }) | { readonly adopted: WebServerInfo }
  >
  /** Per server, in the same order: does its port accept a connection right now. */
  readonly accepting: ReadonlyArray<() => Promise<boolean>>
}

/**
 * The project's `webServer` entries, kept running across runs. The entries are learned by loading
 * the project's config with the project's own Playwright through a wrapper config, and the same
 * wrapper is what the runner is pointed at, so the runner never starts or stops a server.
 */
export class WebServer extends Context.Service<
  WebServer,
  {
    readonly ensure: (
      project: Project,
      options?: EnsureOptions,
    ) => Effect.Effect<WebServers, PoolError | BuildError>
    /** The entries of a project, without starting anything. */
    readonly entries: (project: Project) => Effect.Effect<ReadonlyArray<WebServerEntry>, PoolError>
    /** The project's servers as they are right now. Starts nothing and waits for nothing. */
    readonly snapshot: (project: Project) => Effect.Effect<ReadonlyArray<ServerSnapshot>>
  }
>()("cook/WebServer") {
  static readonly layer = Layer.effect(
    WebServer,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const layerScope = yield* Effect.scope
      const projects = new Map<string, ProjectServers>()
      const learnedEntries = new Map<string, Learned>()
      /** Last successful build per project and entry, as far as this daemon knows. */
      const builds = new Map<string, BuildRecord>()
      const locks = new Map<string, Semaphore.Semaphore>()
      const lockFor = (project: Project) => {
        let lock = locks.get(project.configFile)
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1)
          locks.set(project.configFile, lock)
        }
        return lock
      }
      const idOf = (project: Project) =>
        createHash("sha256").update(project.configFile).digest("hex").slice(0, 12)

      const entries = (project: Project) =>
        Effect.scoped(
          Effect.gen(function* () {
            const id = idOf(project)
            const dump = join(cookHome("tmp"), `webserver-${id}.json`)
            const logFile = join(cookHome("logs"), `config-${id}.log`)
            const error = (reason: string) =>
              new PoolError({ server: "web server", reason, logTail: tail(logFile) })
            rmSync(dump, { force: true })
            writeFileSync(logFile, "")
            writeFileSync(wrapperPath(project), wrapperSource(project))
            // `--list` loads the config and the test files and starts nothing.
            const handle = yield* spawnGuarded(
              spawner,
              {
                command: process.execPath,
                args: [project.playwrightCli, "test", "--list", "--config", wrapperPath(project)],
                cwd: project.configDir,
                env: { ...process.env, ...project.env, COOK_WEBSERVER_DUMP: dump },
              },
              logFile,
            ).pipe(Effect.mapError(error))
            yield* handle.exitCode.pipe(Effect.mapError((e) => error(e.message)))
            return yield* Effect.try({
              try: () => parseWebServerDump(readFileSync(dump, "utf8")),
              catch: (e) => error(`could not read webServer from the project's config: ${String(e)}`),
            })
          }),
        )

      const startAll = (project: Project, learned: Learned, plan: ServingPlan) =>
        Effect.gen(function* () {
          const found = learned.entries
          // The wrapper is removed whenever the servers are stopped; put it back.
          writeFileSync(wrapperPath(project), wrapperSource(project))
          const scope = yield* Scope.fork(layerScope)
          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => rmSync(wrapperPath(project), { force: true })),
          )
          const id = idOf(project)
          const servers: Array<ProjectServers["servers"][number]> = []
          const accepting: Array<() => Promise<boolean>> = []
          for (const [index, entry] of found.entries()) {
            const serve = plan.servers[index] ?? { mode: "dev" as const, command: entry.command }
            const info = describe(entry, index, serve)
            const probe = probeFor(entry)
            accepting.push(acceptingFor(entry))
            if ((entry.url !== undefined || entry.port !== undefined) && (yield* Effect.promise(probe))) {
              // A server Cook did not start serves nobody knows what: never adopt one for a build.
              if (entry.reuseExistingServer && serve.mode === "dev") {
                servers.push({ adopted: { ...info, adopted: true } })
                continue
              }
              yield* Scope.close(scope, Exit.void)
              return yield* Effect.fail(
                new PoolError({
                  server: info.name,
                  reason:
                    serve.mode === "build"
                      ? `${info.url} is already in use by a process Cook did not start; stop it, because Cook has to serve the build there itself`
                      : `${info.url} is already in use by a process Cook did not start, and the config sets reuseExistingServer: false`,
                }),
              )
            }
            servers.push({
              info,
              ...(yield* supervise<WebServerInfo>(
                {
                  name: info.name,
                  logFile: join(cookHome("logs"), `web-server-${id}-${index}.log`),
                  readyTimeoutMs: entry.timeout ?? 60_000,
                  launch: Effect.succeed({
                    command: serve.command,
                    args: [],
                    shell: true,
                    cwd: entry.cwd,
                    env: { ...process.env, ...project.env, ...entry.env },
                    probe,
                    info,
                  }),
                },
                spawner,
              ).pipe(Scope.provide(scope))),
            })
          }
          // Playwright derives baseURL from the first entry that sets `port`; keep that working.
          const withPort = found.find((entry) => entry.port !== undefined)
          const runnerEnv: Record<string, string> =
            withPort !== undefined ? { PLAYWRIGHT_TEST_BASE_URL: `http://localhost:${withPort.port}` } : {}
          return {
            scope,
            learned,
            planKey: plan.key,
            runnerEnv,
            servers,
            accepting,
          } satisfies ProjectServers
        })

      const recordFile = (id: string) => join(cookHome("builds"), `${id}.json`)
      const remember = (id: string, record: BuildRecord, persist: boolean) => {
        builds.set(id, record)
        // Without declared outputs nothing proves the build is still there after a daemon restart.
        if (persist) writeFileSync(recordFile(id), JSON.stringify(record))
      }

      /** Looks at one build-served entry: its inputs now, and whether its last build is current. */
      const inspect = (project: Project, entry: WebServerEntry, index: number, plan: ServerPlan) => {
        const build = plan.build
        if (build === undefined) return null
        const id = `${idOf(project)}-${index}`
        const key = buildKey(build, entry, project.env)
        const inputs = scanFiles(project.root, build.inputs, [
          ...(build.ignore ?? []),
          ...(build.outputs ?? []),
        ])
        if (inputs.size === 0) {
          throw new ConfigProblem(`${cookConfigName}: the inputs of ${nameOf(entry, index)} match no file`)
        }
        const outputs = build.outputs !== undefined ? scanOutputs(project.root, build.outputs) : null
        let record = builds.get(id) ?? null
        if (record === null && build.outputs !== undefined) {
          try {
            record = parseBuildRecord(readFileSync(recordFile(id), "utf8"))
          } catch {}
        }
        const freshness = decideFreshness(
          record,
          key,
          inputs,
          outputs,
          (path) => hashFile(join(project.root, path)),
          Date.now(),
        )
        if (freshness.fresh && builds.get(id) !== freshness.record) {
          remember(id, freshness.record, build.outputs !== undefined && freshness.record !== record)
        }
        return { id, key, inputs, build, freshness }
      }
      type Inspected = NonNullable<ReturnType<typeof inspect>>

      /** Runs the project's build command to the end. The record is written only when it succeeds. */
      const runBuild = (
        project: Project,
        entry: WebServerEntry,
        index: number,
        found: Inspected,
        spent: { readonly checkMs: number; readonly buildMs: number },
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const { build, id } = found
            const logFile = join(cookHome("logs"), `build-${id}.log`)
            const startedAt = performance.now()
            const fail = (reason: string) =>
              new BuildError({
                kind: "build",
                server: nameOf(entry, index),
                reason,
                logTail: tail(logFile, 40),
                logFile,
                checkMs: spent.checkMs,
                buildMs: spent.buildMs + Math.round(performance.now() - startedAt),
              })
            // A build that fails half way leaves an output nobody can vouch for.
            builds.delete(id)
            rmSync(recordFile(id), { force: true })
            writeFileSync(logFile, "")
            // The inputs are read before the build starts: a file saved while it runs then differs
            // from what is recorded, and the next run builds again.
            const inputs = yield* Effect.try({
              try: () => stampInputs(found.inputs, (path) => hashFile(join(project.root, path)), Date.now()),
              catch: (error) => fail(`could not read the build inputs: ${String(error)}`),
            })
            const handle = yield* spawnGuarded(
              spawner,
              {
                command: build.build,
                args: [],
                shell: true,
                cwd: entry.cwd,
                env: { ...process.env, ...project.env, ...entry.env },
              },
              logFile,
            ).pipe(Effect.mapError(fail))
            const timeoutMs = build.buildTimeoutMs ?? 300_000
            const exit = yield* handle.exitCode.pipe(
              Effect.mapError((error) => fail(error.message)),
              Effect.timeoutOption(Duration.millis(timeoutMs)),
            )
            if (Option.isNone(exit)) {
              return yield* Effect.fail(
                fail(`\`${build.build}\` did not finish in ${timeoutMs} ms and was stopped`),
              )
            }
            if (Number(exit.value) !== 0) {
              return yield* Effect.fail(fail(`\`${build.build}\` exited with code ${exit.value}`))
            }
            const outputs =
              build.outputs !== undefined ? stampOutputs(scanOutputs(project.root, build.outputs)) : null
            if (outputs !== null && Object.keys(outputs).length === 0) {
              return yield* Effect.fail(
                fail(
                  `\`${build.build}\` succeeded but a declared output is missing or empty (${build.outputs?.join(", ")})`,
                ),
              )
            }
            remember(id, { version: 1, key: found.key, inputs, outputs }, outputs !== null)
            return Math.round(performance.now() - startedAt)
          }),
        )

      const ensure = (project: Project, options: EnsureOptions = {}) =>
        Effect.gen(function* () {
          const requested = options.serve ?? "auto"
          let cold = false
          const state = yield* Semaphore.withPermit(
            lockFor(project),
            Effect.gen(function* () {
              const configMtimeMs = statSync(project.configFile).mtimeMs
              const envKey = JSON.stringify(project.env)
              let learned = learnedEntries.get(project.configFile)
              if (
                learned === undefined ||
                learned.configMtimeMs !== configMtimeMs ||
                learned.envKey !== envKey
              ) {
                // The config or the environment changed: the servers may be different ones now.
                cold = true
                const old = projects.get(project.configFile)
                if (old) {
                  projects.delete(project.configFile)
                  yield* Scope.close(old.scope, Exit.void)
                }
                learnedEntries.delete(project.configFile)
                learned = { configMtimeMs, envKey, entries: yield* entries(project) }
                learnedEntries.set(project.configFile, learned)
              }
              const found = learned.entries

              // Cheap when nothing changed: one small file read and one stat per input file.
              const checkStartedAt = performance.now()
              const { plan, checks } = yield* Effect.try({
                try: () => {
                  const plan = planServing(found, loadCookConfig(project.root), requested)
                  const checks = plan.servers.map((server, index) => {
                    const entry = found[index]
                    return entry !== undefined ? inspect(project, entry, index, server) : null
                  })
                  return { plan, checks }
                },
                catch: (error) =>
                  new BuildError({
                    kind: "config",
                    server: cookConfigName,
                    reason: error instanceof Error ? error.message : String(error),
                    checkMs: Math.round(performance.now() - checkStartedAt),
                    buildMs: null,
                  }),
              })
              const checkMs = Math.round((performance.now() - checkStartedAt) * 10) / 10
              const stale = checks.flatMap((check, index) =>
                check !== null && !check.freshness.fresh
                  ? [{ index, check, reason: check.freshness.reason }]
                  : [],
              )
              const rebuilt = new Map<number, string>()
              const existing = projects.get(project.configFile)
              if (
                existing !== undefined &&
                existing.learned === learned &&
                existing.planKey === plan.key &&
                stale.length === 0
              ) {
                return { current: existing, plan, checkMs, buildMs: null, restartStartedAt: null, rebuilt }
              }

              // Another mode, or a stale build. No test runs meanwhile (one run per project), so
              // stop the servers, build, and start them on the new build.
              cold = true
              const restartStartedAt = performance.now()
              if (existing !== undefined) {
                projects.delete(project.configFile)
                yield* Scope.close(existing.scope, Exit.void)
              }
              let buildMs: number | null = null
              for (const item of stale) {
                const entry = found[item.index]
                if (entry === undefined) continue
                buildMs =
                  (buildMs ?? 0) +
                  (yield* runBuild(project, entry, item.index, item.check, {
                    checkMs,
                    buildMs: buildMs ?? 0,
                  }))
                rebuilt.set(item.index, item.reason)
              }
              const created = yield* startAll(project, learned, plan)
              projects.set(project.configFile, created)
              return { current: created, plan, checkMs, buildMs, restartStartedAt, rebuilt }
            }),
          )
          const { current, plan } = state
          const servers = yield* Effect.forEach(
            current.servers,
            (server) =>
              Effect.gen(function* () {
                if ("adopted" in server) return { info: server.adopted }
                const before = yield* server.status
                if (before._tag !== "ready") cold = true
                return yield* server.awaitReady
              }),
            { concurrency: "unbounded" },
          )
          const serving: Serving = {
            requested,
            checkMs: state.checkMs,
            buildMs: state.buildMs,
            restartMs:
              state.restartStartedAt !== null
                ? Math.max(0, Math.round(performance.now() - state.restartStartedAt - (state.buildMs ?? 0)))
                : null,
            servers: current.servers.map((server, index) => {
              const info = "adopted" in server ? server.adopted : server.info
              return { name: info.name, mode: info.mode, rebuilt: state.rebuilt.get(index) ?? null }
            }),
          }
          return {
            config: wrapperPath(project),
            runnerEnv: current.runnerEnv,
            servers,
            cold,
            serving,
            ...(plan.workers !== undefined ? { workers: plan.workers } : {}),
          }
        })

      const snapshot = (project: Project) =>
        Effect.suspend(() => {
          const current = projects.get(project.configFile)
          return Effect.forEach(current?.servers ?? [], (server, index) =>
            Effect.gen(function* () {
              const accepting = yield* Effect.promise(() =>
                (current?.accepting[index] ?? (async () => true))(),
              )
              if ("adopted" in server) {
                const name = server.adopted.name
                return {
                  kind: "web_server",
                  name,
                  pid: null,
                  starts: null,
                  state: "adopted",
                  accepting,
                  mode: server.adopted.mode,
                  detail: server.adopted.command,
                } as const
              }
              const status = yield* server.status
              const ready = status._tag === "ready" ? status.ready : null
              return {
                kind: "web_server",
                name: ready?.info.name ?? server.name,
                pid: ready?.pid ?? null,
                starts: ready?.starts ?? null,
                state: status._tag,
                accepting,
                mode: server.info.mode,
                detail: server.info.command,
              } as const
            }),
          )
        })

      return { ensure, entries, snapshot }
    }),
  )
}
