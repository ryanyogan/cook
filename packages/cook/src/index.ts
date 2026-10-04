import { NodeServices } from "@effect/platform-node"
import { type Effect, Layer } from "effect"
import { BrowserServer } from "./BrowserServer.ts"
import type { CookError } from "./errors.ts"
import type { ProjectSpec } from "./Project.ts"
import { Runner, type RunOptions, type RunResult } from "./Runner.ts"
import { WebServer } from "./WebServer.ts"

export { BrowserServer, type BrowserServerInfo } from "./BrowserServer.ts"
export { type CookError, PoolError, ProjectError, RunError } from "./errors.ts"
export { type Project, type ProjectSpec, resolveProject, type WebServerEntry } from "./Project.ts"
export {
  defaultTestTimeoutMs,
  type PlaywrightReport,
  Runner,
  type RunOptions,
  type RunResult,
  type RunTimings,
} from "./Runner.ts"
export type { Ready, Status } from "./Supervised.ts"
export { WebServer, type WebServerInfo, type WebServers } from "./WebServer.ts"

/**
 * The warm pool: browser servers, web servers and the runner. Everything it starts lives in the
 * scope the layer is built in and is stopped, process trees included, when that scope closes.
 */
export const PoolLive: Layer.Layer<Runner | BrowserServer | WebServer> = Runner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(BrowserServer.layer, WebServer.layer)),
  Layer.provide(NodeServices.layer),
)

/**
 * Runs a Playwright project's suite against the warm pool and returns Playwright's raw JSON report
 * with timings. The first call for a project starts what is missing (`pool.cold` is then true).
 */
export const runSuite = (
  spec: ProjectSpec,
  options?: RunOptions,
): Effect.Effect<RunResult, CookError, Runner> => Runner.use((runner) => runner.run(spec, options))
