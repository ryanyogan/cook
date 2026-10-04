// The Cook daemon: owns the warm pool and serves the HTTP API on 127.0.0.1:COOK_PORT.
import { createServer } from "node:http"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Deferred, Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { routes } from "./Api.ts"
import { Coordinator } from "./Coordinator.ts"
import { PoolLive } from "./index.ts"
import { StoreService } from "./StoreService.ts"

export const defaultPort = 4050

const port = Number(process.env.COOK_PORT ?? defaultPort)
const host = "127.0.0.1"

const program = Effect.gen(function* () {
  const stopped = yield* Deferred.make<void>()
  // Give the response to the stop request time to leave before the server closes.
  const stop = Effect.asVoid(
    Effect.forkDetach(Effect.andThen(Effect.sleep("100 millis"), Deferred.succeed(stopped, undefined))),
  )
  const Engine = Coordinator.layer.pipe(Layer.provideMerge(StoreService.layer), Layer.provide(PoolLive))
  const Server = HttpRouter.serve(routes({ port, startedAt: Date.now(), stop }), {
    disableLogger: true,
    disableListenLog: true,
  }).pipe(
    Layer.provide(Engine),
    Layer.provide(NodeHttpServer.layer(createServer, { port, host, gracefulShutdownTimeout: "1 second" })),
  )
  yield* Effect.logInfo(`cook daemon ${process.pid} listening on http://${host}:${port}`)
  // Leaving this race closes the scope of the layer: the server, the pool and the store.
  yield* Effect.raceFirst(Layer.launch(Server), Deferred.await(stopped))
  yield* Effect.logInfo("cook daemon stopped")
})

NodeRuntime.runMain(program)
