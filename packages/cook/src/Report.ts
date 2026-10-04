import { dirname, join, relative, sep } from "node:path"
import type { PlaywrightReport } from "./Runner.ts"

export type TestStatus = "passed" | "failed" | "timed_out" | "skipped" | "interrupted"

/** One test of one run, flattened out of Playwright's JSON report. */
export interface TestRow {
  /** Stable across line changes: file, describe titles and test title, plus the project if named. */
  readonly testId: string
  /** Relative to the directory of the Playwright config, which is where the runner is started. */
  readonly file: string
  readonly line: number
  readonly title: string
  readonly titlePath: ReadonlyArray<string>
  /** Playwright project (browser) name; null when the config names none. */
  readonly project: string | null
  readonly status: TestStatus
  readonly durationMs: number
  /** Start, in milliseconds after the first test of the run started. */
  readonly startedMs: number | null
  readonly message: string | null
  /** The source line Playwright marks as the failing call. */
  readonly step: string | null
  /** Files Playwright kept for this test, where the target project left them. */
  readonly tracePath: string | null
  readonly errorContextPath: string | null
}

interface JsonError {
  readonly message?: string
  readonly snippet?: string
}
interface JsonResult {
  readonly status?: string
  readonly duration?: number
  readonly startTime?: string
  readonly error?: JsonError
  readonly errors?: ReadonlyArray<JsonError>
  readonly attachments?: ReadonlyArray<{ readonly name?: string; readonly path?: string }>
}
interface JsonTest {
  readonly projectName?: string
  readonly expectedStatus?: string
  readonly status?: string
  readonly results?: ReadonlyArray<JsonResult>
}
interface JsonSpec {
  readonly title?: string
  readonly file?: string
  readonly line?: number
  readonly tests?: ReadonlyArray<JsonTest>
}
interface JsonSuite {
  readonly title?: string
  readonly specs?: ReadonlyArray<JsonSpec>
  readonly suites?: ReadonlyArray<JsonSuite>
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences is the point
const ansi = /\u001b\[[0-9;]*[A-Za-z]/g
export const stripAnsi = (text: string): string => text.replace(ansi, "")

/** The line of a Playwright code snippet that is marked with `>`, without the gutter. */
export const failingStep = (snippet: string | undefined): string | null => {
  if (snippet === undefined) return null
  for (const line of stripAnsi(snippet).split("\n")) {
    const marked = /^>\s*\d+\s*\|(.*)$/.exec(line)
    if (marked) return (marked[1] ?? "").trim() || null
  }
  return null
}

const statusOf = (test: JsonTest, result: JsonResult | undefined): TestStatus => {
  if (test.status === "skipped" || result === undefined) return "skipped"
  // "expected" covers tests marked `test.fail()` that did fail: for Playwright that is a pass.
  if (test.status === "expected") return "passed"
  if (result.status === "timedOut") return "timed_out"
  if (result.status === "interrupted") return "interrupted"
  return "failed"
}

const messageOf = (test: JsonTest, result: JsonResult | undefined, status: TestStatus): string | null => {
  if (status === "passed" || status === "skipped") return null
  const text = result?.error?.message ?? result?.errors?.[0]?.message
  if (text !== undefined) return stripAnsi(text).trim()
  if (result?.status === "passed") return `Expected the test to end as ${test.expectedStatus}, but it passed.`
  return `The test ended as ${result?.status ?? "unknown"} without an error message.`
}

/**
 * Every test of a Playwright JSON report as a flat list. Cook never retries, so a test has one
 * result; if a report has more, the last one counts.
 */
export const testRows = (report: PlaywrightReport | null): ReadonlyArray<TestRow> => {
  if (report === null) return []
  const config = report.config as { readonly configFile?: string; readonly rootDir?: string }
  const rootDir = config.rootDir ?? ""
  const configDir = config.configFile !== undefined ? dirname(config.configFile) : rootDir
  const found: Array<Omit<TestRow, "startedMs"> & { readonly startedAt: number | null }> = []
  const walk = (suite: JsonSuite, describes: ReadonlyArray<string>) => {
    for (const spec of suite.specs ?? []) {
      const file = relative(configDir, join(rootDir, spec.file ?? ""))
        .split(sep)
        .join("/")
      const titlePath = [...describes, spec.title ?? ""]
      for (const test of spec.tests ?? []) {
        const result = test.results?.at(-1)
        const status = statusOf(test, result)
        const project = test.projectName ? test.projectName : null
        const startedAt = result?.startTime !== undefined ? Date.parse(result.startTime) : Number.NaN
        const attachment = (name: string) =>
          result?.attachments?.find((a) => a.name === name && typeof a.path === "string")?.path ?? null
        found.push({
          testId: [file, ...titlePath].join(" › ") + (project !== null ? ` [${project}]` : ""),
          file,
          line: spec.line ?? 0,
          title: spec.title ?? "",
          titlePath,
          project,
          status,
          durationMs: Math.round(result?.duration ?? 0),
          startedAt: Number.isNaN(startedAt) || status === "skipped" ? null : startedAt,
          message: messageOf(test, result, status),
          step:
            status === "passed" || status === "skipped"
              ? null
              : failingStep(result?.error?.snippet ?? result?.errors?.[0]?.snippet),
          tracePath: attachment("trace"),
          errorContextPath: attachment("error-context"),
        })
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...describes, child.title ?? ""])
  }
  // The top-level suites are the files; their titles are already in `file`.
  for (const fileSuite of report.suites as ReadonlyArray<JsonSuite>) walk(fileSuite, [])
  const starts = found.flatMap((row) => (row.startedAt === null ? [] : [row.startedAt]))
  const first = starts.length > 0 ? Math.min(...starts) : 0
  return found.map(({ startedAt, ...row }) => ({
    ...row,
    startedMs: startedAt === null ? null : startedAt - first,
  }))
}

/** Errors Playwright reports outside any test: a file that does not load, no tests found. */
export const globalErrors = (report: PlaywrightReport | null): ReadonlyArray<string> =>
  (report?.errors ?? []).map((error) => stripAnsi((error as JsonError).message ?? String(error)).trim())
