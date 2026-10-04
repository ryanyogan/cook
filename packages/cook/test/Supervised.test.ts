import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { NodeServices } from "@effect/platform-node"
import { Effect, Exit, Scope } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { describe, expect, it } from "vitest"
import { freePort, isAlive, tcpAccepts, waitUntil } from "../src/os.ts"
import { supervise } from "../src/Supervised.ts"

// The "servers" here are one-line node programs: no browser, no app.
const listen = (port: number) => `
  require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" })
  console.log("listening")
  require("node:net").createServer().listen(${port}, "127.0.0.1")`
const dir = mkdtempSync(join(tmpdir(), "cook-supervised-"))
const childrenOf = (pid: number) =>
  execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map(Number)
const gone = (pid: number) => waitUntil(async () => !isAlive(pid), { timeoutMs: 5000, intervalMs: 10 })
const run = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

const server = (port: number, logFile: string) => ({
  name: "test server",
  logFile,
  readyTimeoutMs: 5000,
  launch: Effect.succeed({
    command: process.execPath,
    args: ["-e", listen(port)],
    cwd: dir,
    env: { ...process.env },
    probe: () => tcpAccepts("127.0.0.1", port),
    info: port,
  }),
})

describe("supervise", () => {
  it("is ready once the probe passes, restarts a killed process, and stops the whole tree with its scope", () =>
    run(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const port = yield* Effect.promise(() => freePort())
        const logFile = join(dir, "server.log")
        const scope = yield* Scope.make()
        const supervised = yield* supervise(server(port, logFile), spawner).pipe(Scope.provide(scope))

        const first = yield* supervised.awaitReady
        expect(first).toMatchObject({ info: port, starts: 1 })
        expect(yield* supervised.status).toMatchObject({ _tag: "ready" })
        expect(readFileSync(logFile, "utf8")).toContain("listening")

        const [serverPid] = childrenOf(first.pid) as [number]
        process.kill(serverPid, "SIGKILL")
        yield* Effect.promise(() =>
          waitUntil(async () => !isAlive(first.pid), { timeoutMs: 5000, intervalMs: 5 }),
        )
        yield* Effect.sleep("100 millis")
        const second = yield* supervised.awaitReady
        expect(second.starts).toBe(2)
        expect(second.pid).not.toBe(first.pid)

        // The server started a detached grandchild (its own process group, like a browser).
        const [secondServer] = childrenOf(second.pid) as [number]
        const [grandchild] = childrenOf(secondServer) as [number]
        yield* Scope.close(scope, Exit.void)
        expect(yield* Effect.promise(() => gone(second.pid))).toBe(true)
        expect(yield* Effect.promise(() => gone(secondServer))).toBe(true)
        expect(yield* Effect.promise(() => gone(grandchild))).toBe(true)
        expect(yield* Effect.promise(() => tcpAccepts("127.0.0.1", port))).toBe(false)
      }),
    ))

  it("fails with the log tail when the process exits before it is ready, and tries again when asked", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const supervised = yield* supervise(
            {
              name: "broken server",
              logFile: join(dir, "broken.log"),
              readyTimeoutMs: 5000,
              launch: Effect.succeed({
                command: "echo cannot bind >&2; exit 3",
                args: [],
                shell: true,
                cwd: dir,
                env: { ...process.env },
                probe: async () => false,
                info: null,
              }),
            },
            spawner,
          )
          const error = yield* Effect.flip(supervised.awaitReady)
          expect(error).toMatchObject({ _tag: "PoolError", server: "broken server" })
          expect(error.reason).toMatch(/exited with code 3 before it was ready/)
          expect(error.logTail).toContain("cannot bind")
          expect(yield* supervised.status).toMatchObject({ _tag: "failed" })
          const again = yield* Effect.flip(supervised.awaitReady)
          expect(again.reason).toMatch(/exited with code 3/)
        }),
      ),
    ))

  it("fails when the process never becomes ready", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const other = yield* supervise(
            {
              name: "deaf server",
              logFile: join(dir, "deaf.log"),
              readyTimeoutMs: 150,
              launch: Effect.succeed({
                command: process.execPath,
                args: ["-e", "setInterval(() => {}, 1000)"],
                cwd: dir,
                env: { ...process.env },
                probe: async () => false,
                info: null,
              }),
            },
            spawner,
          )
          const error = yield* Effect.flip(other.awaitReady)
          expect(error.reason).toBe("not ready after 150 ms")
        }),
      ),
    ))
})

describe("guard", () => {
  it("stops the command when its parent is killed without a chance to clean up", async () => {
    const guard = fileURLToPath(new URL("../assets/guard.mjs", import.meta.url))
    const port = await freePort()
    // A stand-in daemon: starts the guard the way Cook does, then just sits there.
    const daemon = spawn(
      process.execPath,
      [
        "-e",
        `const c = require("node:child_process").spawn(process.execPath, ${JSON.stringify([guard, join(dir, "orphan.log"), "0", process.execPath, "-e", listen(port)])}, { detached: true, stdio: ["pipe", "ignore", "ignore"] })
         console.log(c.pid); setInterval(() => {}, 1000)`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    )
    const guardPid = await new Promise<number>((resolve) =>
      daemon.stdout.once("data", (chunk) => resolve(Number(chunk))),
    )
    expect(await waitUntil(() => tcpAccepts("127.0.0.1", port), { timeoutMs: 5000 })).toBe(true)
    const [serverPid] = childrenOf(guardPid) as [number]
    const [grandchild] = childrenOf(serverPid) as [number]

    daemon.kill("SIGKILL")

    expect(await gone(guardPid)).toBe(true)
    expect(await gone(serverPid)).toBe(true)
    expect(await gone(grandchild)).toBe(true)
  })
})
