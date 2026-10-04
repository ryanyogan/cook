import { createHash } from "node:crypto"
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Context, Effect, Exit, Layer, Scope, Semaphore } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { PoolError } from "./errors.ts"
import { cookHome, portUsed, tail, urlAvailable } from "./os.ts"
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
}

export interface WebServers {
  /** Config file to hand the runner: the project's config without `webServer`. */
  readonly config: string
  /** Environment the runner needs because `webServer` was removed from its config. */
  readonly runnerEnv: Readonly<Record<string, string>>
  readonly servers: ReadonlyArray<Ready<WebServerInfo> | { readonly info: WebServerInfo }>
  /** True when this call had to learn the entries or wait for a server to start. */
  readonly cold: boolean
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

const describe = (entry: WebServerEntry, index: number): WebServerInfo => ({
  name: entry.name ?? `webServer[${index}]`,
  command: entry.command,
  ...(entry.url !== undefined
    ? { url: entry.url }
    : entry.port !== undefined
      ? { url: `http://localhost:${entry.port}` }
      : {}),
  adopted: false,
})

interface ProjectServers {
  readonly scope: Scope.Closeable
  readonly configMtimeMs: number
  readonly envKey: string
  readonly runnerEnv: Readonly<Record<string, string>>
  readonly servers: ReadonlyArray<Supervised<WebServerInfo> | { readonly adopted: WebServerInfo }>
}

/**
 * The project's `webServer` entries, kept running across runs. The entries are learned by loading
 * the project's config with the project's own Playwright through a wrapper config, and the same
 * wrapper is what the runner is pointed at, so the runner never starts or stops a server.
 */
export class WebServer extends Context.Service<
  WebServer,
  {
    readonly ensure: (project: Project) => Effect.Effect<WebServers, PoolError>
    /** The entries of a project, without starting anything. */
    readonly entries: (project: Project) => Effect.Effect<ReadonlyArray<WebServerEntry>, PoolError>
  }
>()("cook/WebServer") {
  static readonly layer = Layer.effect(
    WebServer,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const layerScope = yield* Effect.scope
      const lock = yield* Semaphore.make(1)
      const projects = new Map<string, ProjectServers>()
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

      const startAll = (project: Project) =>
        Effect.gen(function* () {
          const found = yield* entries(project)
          const scope = yield* Scope.fork(layerScope)
          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => rmSync(wrapperPath(project), { force: true })),
          )
          const id = idOf(project)
          const servers: Array<Supervised<WebServerInfo> | { readonly adopted: WebServerInfo }> = []
          for (const [index, entry] of found.entries()) {
            const info = describe(entry, index)
            const probe = probeFor(entry)
            if ((entry.url !== undefined || entry.port !== undefined) && (yield* Effect.promise(probe))) {
              if (entry.reuseExistingServer) {
                servers.push({ adopted: { ...info, adopted: true } })
                continue
              }
              yield* Scope.close(scope, Exit.void)
              return yield* Effect.fail(
                new PoolError({
                  server: info.name,
                  reason: `${info.url} is already in use by a process Cook did not start, and the config sets reuseExistingServer: false`,
                }),
              )
            }
            servers.push(
              yield* supervise<WebServerInfo>(
                {
                  name: info.name,
                  logFile: join(cookHome("logs"), `web-server-${id}-${index}.log`),
                  readyTimeoutMs: entry.timeout ?? 60_000,
                  launch: Effect.succeed({
                    command: entry.command,
                    args: [],
                    shell: true,
                    cwd: entry.cwd,
                    env: { ...process.env, ...project.env, ...entry.env },
                    probe,
                    info,
                  }),
                },
                spawner,
              ).pipe(Scope.provide(scope)),
            )
          }
          // Playwright derives baseURL from the first entry that sets `port`; keep that working.
          const withPort = found.find((entry) => entry.port !== undefined)
          const runnerEnv: Record<string, string> =
            withPort !== undefined ? { PLAYWRIGHT_TEST_BASE_URL: `http://localhost:${withPort.port}` } : {}
          return {
            scope,
            configMtimeMs: statSync(project.configFile).mtimeMs,
            envKey: JSON.stringify(project.env),
            runnerEnv,
            servers,
          } satisfies ProjectServers
        })

      const ensure = (project: Project) =>
        Effect.gen(function* () {
          let cold = false
          const current = yield* Semaphore.withPermit(
            lock,
            Effect.gen(function* () {
              const existing = projects.get(project.configFile)
              if (existing) {
                const unchanged =
                  existing.configMtimeMs === statSync(project.configFile).mtimeMs &&
                  existing.envKey === JSON.stringify(project.env)
                if (unchanged) return existing
                // The config or the environment changed: the servers may be different ones now.
                projects.delete(project.configFile)
                yield* Scope.close(existing.scope, Exit.void)
              }
              cold = true
              const created = yield* startAll(project)
              projects.set(project.configFile, created)
              return created
            }),
          )
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
          return { config: wrapperPath(project), runnerEnv: current.runnerEnv, servers, cold }
        })

      return { ensure, entries }
    }),
  )
}
