import type { TestRow } from "./Report.ts"
import type { Artifacts } from "./Verdict.ts"

/**
 * How a run treats tracing.
 * - `on-failure-rerun` (default): the run has tracing off; the tests that failed are then run once
 *   more with tracing on, only to collect the trace. That rerun never changes the verdict.
 * - `project`: the project's own `trace` setting is left alone, and nothing is rerun.
 * - `off`: tracing off, nothing is rerun.
 */
export const tracePolicies = ["on-failure-rerun", "project", "off"] as const
export type TracePolicy = (typeof tracePolicies)[number]
export const defaultTracePolicy: TracePolicy = "on-failure-rerun"

/** `longest-first`: slowest recorded tests are queued first. `project`: Playwright's own order. */
export const orderPolicies = ["longest-first", "project"] as const
export type OrderPolicy = (typeof orderPolicies)[number]
export const defaultOrderPolicy: OrderPolicy = "longest-first"

/** What the diagnostic rerun said about one failed test. */
export type RerunOutcome = "passed" | "failed" | "not_run"

/** `--trace` for the run that decides the verdict; undefined leaves the project's setting alone. */
export const firstRunTrace = (policy: TracePolicy): "off" | undefined =>
  policy === "project" ? undefined : "off"

/** More failures than this are a broken build, not something traces of each test help with. */
export const defaultRerunLimit = 20

export interface RerunSelection {
  /** The failed tests that are rerun (the first `limit`). */
  readonly rows: ReadonlyArray<TestRow>
  /** `file:line` filters for `playwright test`. */
  readonly files: ReadonlyArray<string>
  /** `--project` arguments, when the failed tests name their projects. */
  readonly extraArgs: ReadonlyArray<string>
}

/** Which tests the diagnostic rerun runs. Null when there is nothing to rerun. */
export const rerunSelection = (
  policy: TracePolicy,
  failed: ReadonlyArray<TestRow>,
  limit: number = defaultRerunLimit,
): RerunSelection | null => {
  if (policy !== "on-failure-rerun" || failed.length === 0 || limit <= 0) return null
  const rows = failed.slice(0, limit)
  const projects = [...new Set(rows.flatMap((row) => (row.project !== null ? [row.project] : [])))]
  return {
    rows,
    files: [...new Set(rows.map((row) => `${row.file}:${row.line}`))],
    // A `file:line` filter selects the test in every project; this keeps it to the ones that failed.
    extraArgs: projects.map((name) => `--project=${name}`),
  }
}

/**
 * The rerun's result for each failed test of the deciding run. A test the rerun did not reach
 * (not selected, skipped, interrupted, or the rerun itself broke) is `not_run`.
 */
export const rerunOutcomes = (
  failed: ReadonlyArray<TestRow>,
  rerunRows: ReadonlyArray<TestRow> | null,
): ReadonlyMap<string, RerunOutcome> => {
  const byId = new Map((rerunRows ?? []).map((row) => [row.testId, row]))
  return new Map(
    failed.map((row): [string, RerunOutcome] => {
      const again = byId.get(row.testId)
      if (again === undefined || again.status === "skipped" || again.status === "interrupted") {
        return [row.testId, "not_run"]
      }
      return [row.testId, again.status === "passed" ? "passed" : "failed"]
    }),
  )
}

/** The deciding run's artifacts win; the rerun fills in what that run did not record (the trace). */
export const mergeArtifacts = (
  first: ReadonlyMap<string, Artifacts>,
  rerun: ReadonlyMap<string, Artifacts>,
): ReadonlyMap<string, Artifacts> => {
  const merged = new Map(first)
  for (const [id, again] of rerun) {
    const base = first.get(id)
    merged.set(id, {
      trace: base?.trace ?? again.trace,
      consoleErrors: base?.consoleErrors ?? again.consoleErrors,
      domSnapshot: base?.domSnapshot ?? again.domSnapshot,
    })
  }
  return merged
}
