import { Schema } from "effect"
import type { TestRow } from "./Report.ts"
import type { RunTimings } from "./Runner.ts"

export const verdictSchema = "cook.verdict/1"

const Timing = Schema.Struct({
  /** Wall time of the run that was not spent between the first test starting and the last ending. */
  overhead_ms: Schema.Number,
  /** Sum of the durations of all tests (more than the wall time when workers run in parallel). */
  tests_ms: Schema.Number,
  slowest_test_ms: Schema.Number,
  /** Request received by the daemon to the first test starting. Null when no test started. */
  first_test_ms: Schema.NullOr(Schema.Number),
  /** Waiting for an earlier run of the same project. */
  queue_ms: Schema.Number,
  /** Waiting for the browser server and the web servers. Near zero on a warm pool. */
  ready_wait_ms: Schema.Number,
  /** Runner spawn to Playwright having loaded the config and the test files. */
  load_ms: Schema.NullOr(Schema.Number),
  /** Runner spawn to the first test starting. */
  runner_start_ms: Schema.NullOr(Schema.Number),
  /** `cook run` invoked to the request reaching the daemon. Null when the client did not say. */
  client_ms: Schema.NullOr(Schema.Number),
})

export const Failure = Schema.Struct({
  /** `file:line`, the file relative to the directory of the Playwright config. */
  test: Schema.String,
  name: Schema.String,
  /** Playwright project (browser) the test ran in; null when the config names none. */
  project: Schema.NullOr(Schema.String),
  /** `cap`: stopped at the per-test cap. `error`: interrupted before it finished. */
  kind: Schema.Literals(["assertion", "cap", "error"]),
  /** The source line of the failing call. */
  step: Schema.NullOr(Schema.String),
  message: Schema.String,
  /** Playwright trace zip, when the project's own config kept one. */
  trace: Schema.NullOr(Schema.String),
  /** Console errors and uncaught page errors read from the trace; null when there is no trace. */
  console_errors: Schema.NullOr(Schema.Array(Schema.String)),
  /** Playwright's error context (markdown with an ARIA snapshot of the page), when it wrote one. */
  dom_snapshot: Schema.NullOr(Schema.String),
  server_logs: Schema.Array(Schema.String),
  repro: Schema.String,
  duration_ms: Schema.Number,
})
export type Failure = typeof Failure.Type

export const VerdictError = Schema.Struct({ reason: Schema.String, message: Schema.String })

export const Verdict = Schema.Struct({
  schema: Schema.Literal(verdictSchema),
  run_id: Schema.String,
  status: Schema.Literals(["pass", "fail", "error"]),
  path: Schema.String,
  duration_ms: Schema.Number,
  timing: Timing,
  /** Tests Playwright selected for this run. */
  selected: Schema.Number,
  /** Known tests of the project that were not selected. */
  skipped: Schema.Number,
  selection_reason: Schema.Literals(["all", "explicit"]),
  counts: Schema.Struct({
    passed: Schema.Number,
    failed: Schema.Number,
    /** Selected, but skipped by the test file itself (`test.skip`, `test.fixme`). */
    skipped: Schema.Number,
    /** Tests the project has, as far as Cook knows; null before the first full run. */
    known: Schema.NullOr(Schema.Number),
  }),
  failures: Schema.Array(Failure),
  quarantined: Schema.Array(Schema.String),
  error: Schema.NullOr(VerdictError),
  /** Playwright has no run seed. Always null; kept for the shape of the Elixir engine's verdict. */
  seed: Schema.Null,
})
export type Verdict = typeof Verdict.Type

export const decodeVerdict = Schema.decodeUnknownSync(Verdict)
export const encodeVerdict = Schema.encodeSync(Verdict)

/** What Cook gathered for a failed test beyond the report. */
export interface Artifacts {
  readonly trace: string | null
  readonly consoleErrors: ReadonlyArray<string> | null
  readonly domSnapshot: string | null
}

export interface VerdictInput {
  readonly runId: string
  readonly path: string
  /** The file or `file:line` filters of the request; empty means the whole suite. */
  readonly files: ReadonlyArray<string>
  readonly capMs: number
  /** Request received to verdict built. */
  readonly durationMs: number
  readonly queueMs: number
  readonly clientMs: number | null
  /** Null when the runner never ran. */
  readonly timings: RunTimings | null
  readonly rows: ReadonlyArray<TestRow>
  readonly artifacts?: ReadonlyMap<string, Artifacts>
  /** Errors Playwright reported outside any test. */
  readonly globalErrors?: ReadonlyArray<string>
  /** Exit code of `playwright test` and whether it left a report; null when it never ran. */
  readonly runner: { readonly exitCode: number; readonly hasReport: boolean; readonly logFile: string } | null
  /** Tests the project has, when the store knows from an earlier full run. */
  readonly known: number | null
  /** Decided by the caller before any report is looked at: a pool death, a refused project. */
  readonly error?: { readonly reason: string; readonly message: string } | null
  /** `cook run <path>` with the options needed to run in the same way. */
  readonly reproPrefix: string
}

export const capMessage = (capMs: number, detail: string | null): string =>
  `Stopped at the per-test cap of ${capMs} ms. Split this test into smaller tests` +
  (detail !== null && detail !== "" ? ` (${detail.split("\n")[0]})` : ".")

const failureOf = (row: TestRow, input: VerdictInput): Failure => {
  const found = input.artifacts?.get(row.testId)
  return {
    test: `${row.file}:${row.line}`,
    name: row.titlePath.join(" › "),
    project: row.project,
    kind: row.status === "timed_out" ? "cap" : row.status === "interrupted" ? "error" : "assertion",
    step: row.step,
    message: row.status === "timed_out" ? capMessage(input.capMs, row.message) : (row.message ?? ""),
    trace: found?.trace ?? null,
    console_errors: found?.consoleErrors ?? null,
    dom_snapshot: found?.domSnapshot ?? null,
    server_logs: [],
    repro: `${input.reproPrefix} ${row.file}:${row.line}`,
    duration_ms: row.durationMs,
  }
}

const runnerError = (input: VerdictInput): { reason: string; message: string } | null => {
  const { runner, rows } = input
  const errors = input.globalErrors ?? []
  if (runner === null) return { reason: "runner_crashed", message: "The runner did not run." }
  if (!runner.hasReport) {
    return {
      reason: "runner_crashed",
      message: `playwright test exited with code ${runner.exitCode} and left no report. Its output is in ${runner.logFile}`,
    }
  }
  if (rows.length === 0) {
    const text = errors.join("\n")
    return /no tests found/i.test(text)
      ? {
          reason: "unknown_tests",
          message: `No tests found for: ${input.files.join(" ") || "(whole suite)"}`,
        }
      : {
          reason: errors.length > 0 ? "test_load_failed" : "no_tests",
          message: text || `Playwright ran no tests. Its output is in ${runner.logFile}`,
        }
  }
  if (errors.length > 0) return { reason: "test_load_failed", message: errors.join("\n") }
  if (runner.exitCode !== 0 && runner.exitCode !== 1) {
    return {
      reason: "runner_crashed",
      message: `playwright test exited with code ${runner.exitCode}. Its output is in ${runner.logFile}`,
    }
  }
  return null
}

/** Builds the verdict of a run. Pure: everything it needs is in `input`. */
export const buildVerdict = (input: VerdictInput): Verdict => {
  const error = input.error ?? runnerError(input)
  const { rows, timings } = input
  const ran = rows.filter((row) => row.status !== "skipped")
  const failed = ran.filter((row) => row.status !== "passed")
  const explicit = input.files.length > 0
  const selected = rows.length
  const known = error !== null && selected === 0 ? input.known : explicit ? input.known : selected
  const testSpan =
    timings !== null && timings.spawnToEndMs !== null && timings.spawnToFirstTestMs !== null
      ? timings.spawnToEndMs - timings.spawnToFirstTestMs
      : 0
  // A run that ended in an error has no trustworthy failures: they are not reported.
  const failures = error === null ? failed.map((row) => failureOf(row, input)) : []
  return {
    schema: verdictSchema,
    run_id: input.runId,
    status: error !== null ? "error" : failed.length > 0 ? "fail" : "pass",
    path: input.path,
    duration_ms: input.durationMs,
    timing: {
      overhead_ms: Math.max(0, input.durationMs - testSpan),
      tests_ms: ran.reduce((sum, row) => sum + row.durationMs, 0),
      slowest_test_ms: ran.reduce((max, row) => Math.max(max, row.durationMs), 0),
      first_test_ms:
        timings !== null && timings.spawnToFirstTestMs !== null
          ? input.queueMs + timings.poolWaitMs + timings.spawnToFirstTestMs
          : null,
      queue_ms: input.queueMs,
      ready_wait_ms: timings?.poolWaitMs ?? 0,
      load_ms: timings?.spawnToBeginMs ?? null,
      runner_start_ms: timings?.spawnToFirstTestMs ?? null,
      client_ms: input.clientMs,
    },
    selected,
    skipped: known !== null ? Math.max(0, known - selected) : 0,
    selection_reason: explicit ? "explicit" : "all",
    counts: {
      passed: ran.length - failed.length,
      failed: failed.length,
      skipped: rows.length - ran.length,
      known: known !== null ? Math.max(known, selected) : null,
    },
    failures,
    quarantined: [],
    error,
    seed: null,
  }
}

export const exitCode = (verdict: Pick<Verdict, "status">): 0 | 1 | 2 =>
  verdict.status === "pass" ? 0 : verdict.status === "fail" ? 1 : 2

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const indent = (text: string, by: string) =>
  text
    .split("\n")
    .map((line) => by + line)
    .join("\n")

/** The short human summary `cook run` prints without `--json`. */
export const summary = (verdict: Verdict): string => {
  if (verdict.status === "error") {
    return `ERROR ${verdict.error?.reason ?? "unknown"} after ${seconds(verdict.duration_ms)}\n${indent(verdict.error?.message ?? "", "  ")}\n`
  }
  const { counts, timing } = verdict
  const head =
    verdict.status === "pass"
      ? `PASS ${counts.passed} tests in ${seconds(verdict.duration_ms)}`
      : `FAIL ${counts.failed} of ${counts.passed + counts.failed} tests failed in ${seconds(verdict.duration_ms)}`
  const notes = [
    `overhead ${seconds(timing.overhead_ms)}`,
    `slowest test ${seconds(timing.slowest_test_ms)}`,
    ...(counts.skipped > 0 ? [`${counts.skipped} skipped by the test files`] : []),
    ...(verdict.skipped > 0 ? [`${verdict.skipped} not selected`] : []),
  ]
  const lines = [`${head} (${notes.join(", ")})`]
  for (const failure of verdict.failures) {
    lines.push(
      "",
      `  ${failure.test}  ${failure.name}${failure.project !== null ? ` [${failure.project}]` : ""}`,
    )
    lines.push(indent(failure.message, "    "))
    if (failure.step !== null) lines.push(`    at: ${failure.step}`)
    if (failure.trace !== null) lines.push(`    trace: ${failure.trace}`)
    if (failure.dom_snapshot !== null) lines.push(`    page: ${failure.dom_snapshot}`)
    for (const line of failure.console_errors ?? []) lines.push(`    console: ${line}`)
    lines.push(`    repro: ${failure.repro}`)
  }
  return `${lines.join("\n")}\n`
}
