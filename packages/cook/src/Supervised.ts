import { fileURLToPath } from "node:url"
import { Deferred, Effect, Ref, type Scope } from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"
import { PoolError } from "./errors.ts"
import { isAlive, tail, waitUntil } from "./os.ts"

const guardScript = fileURLToPath(new URL("../assets/guard.mjs", import.meta.url))

/** What to start. Computed again for every (re)start, so a restart can pick a new port. */
export interface Launch<Info> {
  readonly command: string
  readonly args: ReadonlyArray<string>
  /** Run `command` through the shell (web server commands are shell strings). */
  readonly shell?: boolean
  readonly cwd: string
  /** The complete environment of the process. */
  readonly env: Record<string, string | undefined>
  /** True once the process serves. Polled until true, the timeout, or the process exits. */
  readonly probe: () => Promise<boolean>
  /** Handed to callers once ready (endpoint, URL, ...). */
  readonly info: Info
}

export interface SupervisedSpec<Info> {
  readonly name: string
  readonly logFile: string
  readonly readyTimeoutMs: number
  readonly launch: Effect.Effect<Launch<Info>, PoolError>
}

export interface Ready<Info> {
  readonly info: Info
  /** Process id of the guard, which leads the process group of the server. */
  readonly pid: number
  /** Milliseconds from spawn to the first successful readiness probe. */
  readonly startMs: number
  /** How many times the process was started; 1 means never restarted. */
  readonly starts: number
}

export type Status<Info> =
  | { readonly _tag: "starting" }
  | { readonly _tag: "ready"; readonly ready: Ready<Info> }
  | { readonly _tag: "failed"; readonly error: PoolError }

export interface Supervised<Info> {
  readonly name: string
  readonly status: Effect.Effect<Status<Info>>
  /**
   * The ready process. Waits while it is starting or restarting. If the last start failed, this
   * call triggers one new attempt and waits for it.
   */
  readonly awaitReady: Effect.Effect<Ready<Info>, PoolError>
}

/** The part of a launch that `spawnGuarded` needs. */
export type Command = Pick<Launch<unknown>, "command" | "args" | "shell" | "cwd" | "env">

/**
 * Spawns a command under the guard, output appended to `logFile`. The process and everything it
 * started are stopped when the scope closes, and also when this process dies without closing it.
 * Fails with a plain reason string.
 */
export const spawnGuarded = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: Command,
  logFile: string,
): Effect.Effect<ChildProcessSpawner.ChildProcessHandle, string, Scope.Scope> =>
  Effect.gen(function* () {
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(
          process.execPath,
          [guardScript, logFile, command.shell ? "1" : "0", command.command, ...command.args],
          {
            cwd: command.cwd,
            env: command.env,
            extendEnv: false,
            // The guard watches this pipe: when we die it closes, and the guard cleans up.
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
            // The spawner's own cleanup runs after ours below: signal the group, then force.
            forceKillAfter: "3 seconds",
          },
        ),
      )
      .pipe(Effect.mapError((error) => `cannot start ${command.command}: ${error.message}`))
    const pid = Number(handle.pid)
    // Ask the guard alone first. It lists every descendant before it signals them, which a
    // signal to the whole group would race with.
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (!isAlive(pid)) return
        try {
          process.kill(pid, "SIGTERM")
        } catch {}
        await waitUntil(async () => !isAlive(pid), { timeoutMs: 4000, intervalMs: 10 })
      }),
    )
    return handle
  })

interface State<Info> {
  readonly status: Status<Info>
  readonly ready: Deferred.Deferred<Ready<Info>, PoolError>
  /** Completed to ask a failed supervisor for another attempt. */
  readonly kick: Deferred.Deferred<void>
}

/**
 * Starts an OS process under the guard (`assets/guard.mjs`) and keeps it running for the lifetime
 * of the scope: when the process dies after having been ready it is started again. A start that
 * never becomes ready is not retried in a loop; the next `awaitReady` asks for one more attempt.
 * Closing the scope stops the process and everything it started.
 */
export const supervise = <Info>(
  spec: SupervisedSpec<Info>,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): Effect.Effect<Supervised<Info>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const fresh = Effect.gen(function* () {
      const ready = yield* Deferred.make<Ready<Info>, PoolError>()
      const kick = yield* Deferred.make<void>()
      return { status: { _tag: "starting" }, ready, kick } satisfies State<Info>
    })
    const state = yield* Ref.make<State<Info>>(yield* fresh)
    let starts = 0

    const fail = (reason: string) => new PoolError({ server: spec.name, reason, logTail: tail(spec.logFile) })

    /** One life of the process: resolves with why it ended. Fails if it never became ready. */
    const life = Effect.scoped(
      Effect.gen(function* () {
        const launch = yield* spec.launch
        const startedAt = Date.now()
        starts += 1
        const handle = yield* spawnGuarded(spawner, launch, spec.logFile).pipe(
          Effect.mapError((reason) => fail(reason)),
        )
        const pid = Number(handle.pid)
        const exited = handle.exitCode.pipe(
          Effect.map((code) => `exited with code ${code}`),
          Effect.catch((error) => Effect.succeed(`lost: ${error.message}`)),
        )
        const becameReady = yield* Effect.raceFirst(
          Effect.promise((signal) =>
            waitUntil(launch.probe, { timeoutMs: spec.readyTimeoutMs, signal }),
          ).pipe(Effect.map((ok) => (ok ? ("ready" as const) : ("timeout" as const)))),
          exited,
        )
        if (becameReady === "timeout") {
          return yield* Effect.fail(fail(`not ready after ${spec.readyTimeoutMs} ms`))
        }
        if (becameReady !== "ready") {
          return yield* Effect.fail(fail(`${becameReady} before it was ready`))
        }
        const ready: Ready<Info> = { info: launch.info, pid, startMs: Date.now() - startedAt, starts }
        const current = yield* Ref.get(state)
        yield* Ref.set(state, { ...current, status: { _tag: "ready", ready } })
        yield* Deferred.succeed(current.ready, ready)
        return yield* exited
      }),
    )

    const loop = Effect.gen(function* () {
      for (;;) {
        const result = yield* Effect.result(life)
        if (result._tag === "Success") {
          // It was ready and died: start again at once, with a new waiter.
          yield* Effect.logWarning(`${spec.name} ${result.success}; restarting`)
          yield* Ref.set(state, yield* fresh)
          continue
        }
        const error = result.failure
        const current = yield* Ref.get(state)
        yield* Ref.set(state, { ...current, status: { _tag: "failed", error } })
        yield* Deferred.fail(current.ready, error)
        yield* Deferred.await(current.kick)
        yield* Ref.set(state, yield* fresh)
      }
    })
    yield* Effect.forkScoped(loop)

    const awaitReady: Effect.Effect<Ready<Info>, PoolError> = Effect.gen(function* () {
      const current = yield* Ref.get(state)
      if (current.status._tag === "ready") return current.status.ready
      if (current.status._tag === "starting") return yield* Deferred.await(current.ready)
      // Failed: ask for one more attempt, wait for the supervisor to swap the state, then wait.
      yield* Deferred.succeed(current.kick, undefined)
      for (;;) {
        yield* Effect.sleep("5 millis")
        const next = yield* Ref.get(state)
        if (next.ready !== current.ready) {
          return yield* next.status._tag === "ready"
            ? Effect.succeed(next.status.ready)
            : Deferred.await(next.ready)
        }
      }
    })

    return { name: spec.name, status: Effect.map(Ref.get(state), (s) => s.status), awaitReady }
  })
