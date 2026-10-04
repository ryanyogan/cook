import { readFileSync } from "node:fs"
import { expect, test } from "vitest"
import { failingStep, globalErrors, stripAnsi, testRows } from "../src/Report.ts"
import type { PlaywrightReport, RunTimings } from "../src/Runner.ts"
import { buildVerdict, decodeVerdict, exitCode, summary, type VerdictInput } from "../src/Verdict.ts"

// Three tests cut from a real report of the fixture's flaky test (one failed), machine paths replaced.
const report = JSON.parse(
  readFileSync(new URL("./fixtures/report-failed.json", import.meta.url), "utf8"),
) as PlaywrightReport

const timings: RunTimings = {
  poolWaitMs: 1,
  spawnToBeginMs: 400,
  spawnToFirstTestMs: 700,
  spawnToEndMs: 2700,
  spawnToExitMs: 2760,
  totalMs: 2765,
}

const input = (over: Partial<VerdictInput> = {}): VerdictInput => ({
  runId: "run-1",
  path: "/work/app",
  files: [],
  capMs: 10_000,
  durationMs: 2800,
  queueMs: 5,
  clientMs: 40,
  timings,
  rows: testRows(report),
  runner: { exitCode: 1, hasReport: true, logFile: "/runs/run-1/output.log" },
  known: null,
  reproPrefix: "cook run /work/app",
  ...over,
})

test("rows: file relative to the config directory, title path, status, start offsets", () => {
  const rows = testRows(report)
  expect(rows.map((r) => [r.file, r.line, r.status, r.project])).toEqual([
    ["e2e/estimate.spec.ts", 6, "failed", "chromium"],
    ["e2e/estimate.spec.ts", 20, "passed", "chromium"],
    ["e2e/estimate.spec.ts", 31, "passed", "chromium"],
  ])
  expect(rows[2]?.testId).toBe("e2e/estimate.spec.ts › when signed in › greets the user [chromium]")
  expect(rows[2]?.startedMs).toBe(0)
  expect(rows[0]?.startedMs).toBe(118)
  expect(rows[0]?.tracePath).toMatch(/trace\.zip$/)
  expect(rows[1]?.message).toBeNull()
  expect(testRows(null)).toEqual([])
})

test("a failing run: one failure entry with step, plain message and repro", () => {
  const verdict = buildVerdict(input())
  expect(verdict.status).toBe("fail")
  expect(exitCode(verdict)).toBe(1)
  expect(verdict.selection_reason).toBe("all")
  expect([verdict.selected, verdict.skipped]).toEqual([3, 0])
  expect(verdict.counts).toEqual({ passed: 2, failed: 1, skipped: 0, known: 3 })
  expect(verdict.failures).toHaveLength(1)
  const failure = verdict.failures[0]
  expect(failure?.test).toBe("e2e/estimate.spec.ts:6")
  expect(failure?.kind).toBe("assertion")
  expect(failure?.step).toBe(
    "expect(await page.getByRole('alert').count(), 'the estimator answered with an error').toBe(0)",
  )
  expect(failure?.message).toMatch(/^Error: the estimator answered with an error\n\nexpect\(received\)/)
  expect(failure?.message).not.toContain("\u001b")
  expect(failure?.repro).toBe("cook run /work/app e2e/estimate.spec.ts:6")
  // No artifacts were gathered for this input.
  expect([failure?.trace, failure?.console_errors, failure?.dom_snapshot]).toEqual([null, null, null])
  expect(verdict.quarantined).toEqual([])
  // 2800 ms in all, of which 2000 ms lie between the first test starting and the last ending.
  expect(verdict.timing).toMatchObject({
    overhead_ms: 800,
    tests_ms: 1837 + 1819 + 1827,
    slowest_test_ms: 1837,
    first_test_ms: 5 + 1 + 700,
    queue_ms: 5,
    ready_wait_ms: 1,
    load_ms: 400,
    client_ms: 40,
  })
  // The verdict is what the schema says it is, and survives JSON.
  expect(decodeVerdict(JSON.parse(JSON.stringify(verdict)))).toEqual(verdict)
  expect(summary(verdict)).toContain("FAIL 1 of 3 tests failed in 2.8 s")
  expect(summary(verdict)).toContain("repro: cook run /work/app e2e/estimate.spec.ts:6")
})

test("artifacts gathered for a failure land in its entry", () => {
  const rows = testRows(report)
  const artifacts = new Map([
    [
      rows[0]?.testId ?? "",
      { trace: "/runs/1-trace.zip", consoleErrors: ["boom"], domSnapshot: "/runs/1.md" },
    ],
  ])
  const failure = buildVerdict(input({ artifacts })).failures[0]
  expect([failure?.trace, failure?.console_errors, failure?.dom_snapshot]).toEqual([
    "/runs/1-trace.zip",
    ["boom"],
    "/runs/1.md",
  ])
})

test("all passed; an explicit selection counts the tests not selected", () => {
  const rows = testRows(report).filter((row) => row.status === "passed")
  const verdict = buildVerdict(input({ rows, files: ["e2e/estimate.spec.ts:20"], known: 45 }))
  expect(verdict.status).toBe("pass")
  expect(exitCode(verdict)).toBe(0)
  expect([verdict.selected, verdict.skipped, verdict.selection_reason]).toEqual([2, 43, "explicit"])
  expect(verdict.counts.known).toBe(45)
  expect(summary(verdict)).toMatch(/^PASS 2 tests in 2\.8 s \(.*43 not selected\)/)
  // Before any full run the number of known tests is unknown, and nothing is claimed as skipped.
  const unknown = buildVerdict(input({ rows, files: ["x.spec.ts"], known: null }))
  expect([unknown.skipped, unknown.counts.known]).toEqual([0, null])
})

test("a test stopped at the cap says to split it", () => {
  const rows = testRows(report).map((row, index) =>
    index === 0
      ? { ...row, status: "timed_out" as const, message: "Test timeout of 10000ms exceeded.", step: null }
      : row,
  )
  const failure = buildVerdict(input({ rows })).failures[0]
  expect(failure?.kind).toBe("cap")
  expect(failure?.message).toBe(
    "Stopped at the per-test cap of 10000 ms. Split this test into smaller tests (Test timeout of 10000ms exceeded.)",
  )
})

test("a Playwright timedOut result becomes timed_out; test.fail() that fails is a pass", () => {
  const edited = structuredClone(report) as unknown as {
    suites: Array<{ specs: Array<{ tests: Array<{ status: string; results: Array<{ status: string }> }> }> }>
  }
  const specs = edited.suites[0]?.specs ?? []
  ;(specs[0]?.tests[0]?.results[0] as { status: string }).status = "timedOut"
  ;(specs[1]?.tests[0] as { status: string }).status = "expected"
  ;(specs[1]?.tests[0]?.results[0] as { status: string }).status = "failed"
  const rows = testRows(edited as unknown as PlaywrightReport)
  expect(rows.map((r) => r.status)).toEqual(["timed_out", "passed", "passed"])
})

test("errors decided before the report win, and report no failures", () => {
  const verdict = buildVerdict(
    input({ error: { reason: "browser_server_down", message: "browser server died during the run" } }),
  )
  expect(verdict.status).toBe("error")
  expect(exitCode(verdict)).toBe(2)
  expect(verdict.failures).toEqual([])
  expect(verdict.error?.reason).toBe("browser_server_down")
  expect(summary(verdict)).toMatch(/^ERROR browser_server_down after 2\.8 s\n {2}browser server died/)
})

test("runner outcomes that are not test results are errors", () => {
  const none = { rows: [] as ReturnType<typeof testRows> }
  const reason = (over: Partial<VerdictInput>) => buildVerdict(input(over)).error?.reason
  expect(reason({ ...none, runner: { exitCode: 1, hasReport: false, logFile: "l" } })).toBe("runner_crashed")
  expect(reason({ ...none, runner: null })).toBe("runner_crashed")
  expect(reason({ ...none, globalErrors: ["Error: No tests found"], files: ["nope.spec.ts"] })).toBe(
    "unknown_tests",
  )
  expect(reason({ ...none, globalErrors: ["SyntaxError: bad"] })).toBe("test_load_failed")
  expect(reason({ globalErrors: ["SyntaxError: bad"] })).toBe("test_load_failed")
  expect(reason({ runner: { exitCode: 130, hasReport: true, logFile: "l" } })).toBe("runner_crashed")
  expect(reason({})).toBeUndefined()
})

test("small pieces", () => {
  expect(stripAnsi("\u001b[2mexpect(\u001b[22m\u001b[31mreceived\u001b[39m)")).toBe("expect(received)")
  expect(failingStep("  14 |   a()\n> 16 |   expect(x).toBe(0)\n     |             ^\n  17 | b()")).toBe(
    "expect(x).toBe(0)",
  )
  expect(failingStep(undefined)).toBeNull()
  expect(
    globalErrors({ ...report, errors: [{ message: "\u001b[31mError: No tests found\u001b[39m" }] }),
  ).toEqual(["Error: No tests found"])
})
