import { Data } from "effect"

/** The target project cannot be used: no config, no Playwright installed, config does not load. */
export class ProjectError extends Data.TaggedError("ProjectError")<{
  readonly path: string
  readonly reason: string
}> {}

/** A pooled OS process (browser server or web server) could not be made ready. */
export class PoolError extends Data.TaggedError("PoolError")<{
  readonly server: string
  readonly reason: string
  /** Last lines of the process log, when there is one. */
  readonly logTail?: string
}> {}

/** The runner process could not be started, or left no usable report. */
export class RunError extends Data.TaggedError("RunError")<{
  readonly reason: string
  readonly logFile?: string
}> {}

export type CookError = ProjectError | PoolError | RunError
