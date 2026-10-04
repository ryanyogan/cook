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

/**
 * Build serving could not be used: the project's `cook.config.json` is wrong (`kind: "config"`),
 * or its build command failed (`kind: "build"`). No test ran.
 */
export class BuildError extends Data.TaggedError("BuildError")<{
  readonly kind: "config" | "build"
  readonly server: string
  readonly reason: string
  /** The end of the build's output. */
  readonly logTail?: string
  readonly logFile?: string
  /** Milliseconds spent deciding whether the build was current, and in the build command. */
  readonly checkMs: number
  readonly buildMs: number | null
}> {}

export type CookError = ProjectError | PoolError | RunError | BuildError
