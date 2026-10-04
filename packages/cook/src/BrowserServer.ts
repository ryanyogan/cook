import { join } from "node:path"
import { Context, Effect, Layer, Scope, Semaphore } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { PoolError } from "./errors.ts"
import { cookHome, freePort, tcpAccepts } from "./os.ts"
import type { Project } from "./Project.ts"
import { type Ready, type Status, type Supervised, supervise } from "./Supervised.ts"

export interface BrowserServerInfo {
  readonly playwrightVersion: string
  /** Value for PW_TEST_CONNECT_WS_ENDPOINT. */
  readonly wsEndpoint: string
  readonly port: number
}

export interface Ensured<Info> {
  readonly ready: Ready<Info>
  /** True when this call found the server not ready and had to wait for a start. */
  readonly cold: boolean
}

/**
 * One Playwright `run-server` per Playwright version, started from the node_modules of the first
 * project that needs that version (the server rejects clients of another version).
 */
export class BrowserServer extends Context.Service<
  BrowserServer,
  {
    readonly ensure: (project: Project) => Effect.Effect<Ensured<BrowserServerInfo>, PoolError>
    readonly status: Effect.Effect<
      ReadonlyArray<{ readonly playwrightVersion: string; readonly status: Status<BrowserServerInfo> }>
    >
  }
>()("cook/BrowserServer") {
  static readonly layer = Layer.effect(
    BrowserServer,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const scope = yield* Effect.scope
      const lock = yield* Semaphore.make(1)
      const servers = new Map<string, Supervised<BrowserServerInfo>>()
      const host = "127.0.0.1"

      const start = (project: Project) =>
        supervise<BrowserServerInfo>(
          {
            name: `browser server (Playwright ${project.playwrightVersion})`,
            logFile: join(cookHome("logs"), `browser-server-${project.playwrightVersion}.log`),
            readyTimeoutMs: 30_000,
            launch: Effect.promise(async () => {
              const port = await freePort(host)
              return {
                command: process.execPath,
                args: [project.playwrightCli, "run-server", "--port", String(port), "--host", host],
                cwd: project.root,
                env: { ...process.env },
                probe: () => tcpAccepts(host, port),
                info: {
                  playwrightVersion: project.playwrightVersion,
                  wsEndpoint: `ws://${host}:${port}/`,
                  port,
                },
              }
            }),
          },
          spawner,
        ).pipe(Scope.provide(scope))

      const ensure = (project: Project) =>
        Effect.gen(function* () {
          const server = yield* Semaphore.withPermit(
            lock,
            Effect.gen(function* () {
              const existing = servers.get(project.playwrightVersion)
              if (existing) return existing
              const created = yield* start(project)
              servers.set(project.playwrightVersion, created)
              return created
            }),
          )
          const before = yield* server.status
          const ready = yield* server.awaitReady
          return { ready, cold: before._tag !== "ready" }
        })

      const status = Effect.suspend(() =>
        Effect.forEach([...servers], ([playwrightVersion, server]) =>
          Effect.map(server.status, (s) => ({ playwrightVersion, status: s })),
        ),
      )
      return { ensure, status }
    }),
  )
}
