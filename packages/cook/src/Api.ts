import { Effect, Schema } from "effect"
import { HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/http"
import { Coordinator, type RunRequest } from "./Coordinator.ts"
import { orderPolicies, tracePolicies } from "./Diagnostic.ts"
import { cookHome } from "./os.ts"
import { StoreService } from "./StoreService.ts"
import { encodeVerdict, exitCode, summary, Verdict } from "./Verdict.ts"

export const statusSchema = "cook.status/1"

/** Body of `POST /api/runs`. */
export const RunBody = Schema.Struct({
  path: Schema.String,
  files: Schema.optionalKey(Schema.Array(Schema.String)),
  timeout_ms: Schema.optionalKey(Schema.Number),
  workers: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  config: Schema.optionalKey(Schema.String),
  client_started_ms: Schema.optionalKey(Schema.Number),
  /** `on-failure-rerun` (default), `project` or `off`. */
  trace: Schema.optionalKey(Schema.Literals(tracePolicies)),
  /** `longest-first` (default) or `project`. */
  order: Schema.optionalKey(Schema.Literals(orderPolicies)),
})
const decodeRunBody = Schema.decodeUnknownEffect(RunBody)
const decodeStoredVerdict = Schema.decodeUnknownEffect(Verdict)

export const toRunRequest = (body: typeof RunBody.Type): RunRequest => ({
  path: body.path,
  ...(body.files !== undefined ? { files: body.files } : {}),
  ...(body.timeout_ms !== undefined ? { timeoutMs: body.timeout_ms } : {}),
  ...(body.workers !== undefined ? { workers: body.workers } : {}),
  ...(body.env !== undefined ? { env: body.env } : {}),
  ...(body.config !== undefined ? { config: body.config } : {}),
  ...(body.client_started_ms !== undefined ? { clientStartedMs: body.client_started_ms } : {}),
  ...(body.trace !== undefined ? { trace: body.trace } : {}),
  ...(body.order !== undefined ? { order: body.order } : {}),
})

const query = (request: HttpServerRequest.HttpServerRequest) =>
  new URL(request.url, "http://cook").searchParams
const problem = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: message }, { status })

/** The verdict as JSON, or as the human summary with `?format=text`. The exit code is a header. */
const verdictResponse = (verdict: Verdict, format: string | null) => {
  const headers = { "x-cook-exit-code": String(exitCode(verdict)) }
  return format === "text"
    ? HttpServerResponse.text(summary(verdict), { headers })
    : HttpServerResponse.jsonUnsafe(encodeVerdict(verdict), { headers })
}

export interface DaemonInfo {
  readonly port: number
  readonly startedAt: number
  /** Asks the daemon to shut down once the response has been sent. */
  readonly stop: Effect.Effect<void>
}

/** The daemon's HTTP API. */
export const routes = (daemon: DaemonInfo) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const coordinator = yield* Coordinator
      const store = yield* StoreService

      yield* router.add(
        "GET",
        "/api/status",
        Effect.map(coordinator.status, (projects) =>
          HttpServerResponse.jsonUnsafe({
            schema: statusSchema,
            pid: process.pid,
            port: daemon.port,
            home: cookHome(),
            started_at: new Date(daemon.startedAt).toISOString(),
            uptime_ms: Date.now() - daemon.startedAt,
            projects,
          }),
        ),
      )

      yield* router.add("POST", "/api/runs", (request) =>
        Effect.gen(function* () {
          const body = yield* request.json.pipe(Effect.flatMap(decodeRunBody), Effect.result)
          if (body._tag === "Failure") return problem(400, `bad request: ${String(body.failure)}`)
          const verdict = yield* coordinator.run(toRunRequest(body.success))
          return verdictResponse(verdict, query(request).get("format"))
        }),
      )

      yield* router.add("GET", "/api/runs", (request) =>
        Effect.sync(() => {
          const params = query(request)
          const limit = Math.min(200, Math.max(1, Number(params.get("limit") ?? 20) || 20))
          return HttpServerResponse.jsonUnsafe({ runs: store.recent(limit, params.get("path") ?? undefined) })
        }),
      )

      yield* router.add("GET", "/api/runs/:id", (request) =>
        Effect.gen(function* () {
          const url = new URL(request.url, "http://cook")
          const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "")
          const stored = store.verdict(id)
          if (stored === null) return problem(404, `no run ${id}`)
          const verdict = yield* decodeStoredVerdict(stored).pipe(Effect.result)
          if (verdict._tag === "Failure") return problem(500, `stored verdict of ${id} does not decode`)
          return url.searchParams.get("tests") === "1"
            ? HttpServerResponse.jsonUnsafe({
                verdict: encodeVerdict(verdict.success),
                tests: store.testResults(id),
              })
            : verdictResponse(verdict.success, url.searchParams.get("format"))
        }),
      )

      yield* router.add(
        "POST",
        "/api/stop",
        Effect.as(daemon.stop, HttpServerResponse.jsonUnsafe({ stopping: true, pid: process.pid })),
      )
    }),
  )
