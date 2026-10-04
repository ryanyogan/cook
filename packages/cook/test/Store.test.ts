import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import type { TestRow } from "../src/Report.ts"
import { openStore } from "../src/Store.ts"
import { buildVerdict, decodeVerdict } from "../src/Verdict.ts"

const row = (title: string, status: TestRow["status"], durationMs: number): TestRow => ({
  testId: `a.spec.ts › ${title}`,
  file: "a.spec.ts",
  line: 3,
  title,
  titlePath: [title],
  project: null,
  status,
  durationMs,
  startedMs: 0,
  message: status === "passed" ? null : "nope",
  step: null,
  tracePath: null,
  errorContextPath: null,
})

const verdictOf = (runId: string, rows: ReadonlyArray<TestRow>, files: ReadonlyArray<string> = []) =>
  buildVerdict({
    runId,
    path: "/work/app",
    files,
    capMs: 10_000,
    durationMs: 1234.4,
    queueMs: 0,
    clientMs: null,
    timings: null,
    rows,
    runner: { exitCode: 1, hasReport: true, logFile: "l" },
    known: null,
    reproPrefix: "cook run /work/app",
  })

test("stores a run with every test result and gives the verdict back unchanged", () => {
  const store = openStore(":memory:")
  const rows = [row("one", "passed", 100), row("two", "failed", 250), row("three", "skipped", 0)]
  const verdict = verdictOf("r1", rows)
  store.record(verdict, rows, new Date("2026-10-04T10:00:00Z"))

  expect(decodeVerdict(store.verdict("r1"))).toEqual(verdict)
  expect(store.verdict("missing")).toBeNull()
  expect(
    store.testResults("r1").map((t) => [t.test_id, t.title, t.status, t.duration_ms, t.project_path]),
  ).toEqual([
    ["a.spec.ts › one", "one", "passed", 100, "/work/app"],
    ["a.spec.ts › two", "two", "failed", 250, "/work/app"],
    ["a.spec.ts › three", "three", "skipped", 0, "/work/app"],
  ])
  expect(store.recent(10)).toEqual([
    {
      id: "r1",
      project_path: "/work/app",
      status: "fail",
      selection_reason: "all",
      selected: 3,
      passed: 1,
      failed: 1,
      duration_ms: 1234,
      error_reason: null,
      started_at: "2026-10-04T10:00:00.000Z",
    },
  ])
  store.close()
})

test("known tests come from the latest full run; recent is newest first and filters by path", () => {
  const store = openStore(":memory:")
  expect(store.knownTests("/work/app")).toBeNull()
  const three = [row("one", "passed", 1), row("two", "passed", 1), row("three", "passed", 1)]
  store.record(verdictOf("full", three), three, new Date("2026-10-04T10:00:00Z"))
  store.record(
    verdictOf("part", three.slice(0, 1), ["a.spec.ts:3"]),
    three.slice(0, 1),
    new Date("2026-10-04T11:00:00Z"),
  )
  expect(store.knownTests("/work/app")).toBe(3)
  expect(store.recent(10).map((r) => r.id)).toEqual(["part", "full"])
  expect(store.recent(1).map((r) => r.id)).toEqual(["part"])
  expect(store.recent(10, "/elsewhere")).toEqual([])
  store.close()
})

test("a file database is migrated once and can be reopened; a duplicate run id stores nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "cook-store-"))
  try {
    const file = join(dir, "nested", "cook.sqlite")
    const rows = [row("one", "passed", 5)]
    const first = openStore(file)
    first.record(verdictOf("r1", rows), rows, new Date())
    expect(() => first.record(verdictOf("r1", rows), rows, new Date())).toThrow()
    first.close()
    const again = openStore(file)
    expect(again.recent(10)).toHaveLength(1)
    expect(again.testResults("r1")).toHaveLength(1)
    again.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
