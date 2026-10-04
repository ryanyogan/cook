import { expect, test } from "vitest"
import { firstRunTrace, mergeArtifacts, rerunOutcomes, rerunSelection } from "../src/Diagnostic.ts"
import type { TestRow } from "../src/Report.ts"
import { runnerArgs } from "../src/Runner.ts"

const row = (over: Partial<TestRow>): TestRow => ({
  testId: "a.spec.ts › one [chromium]",
  file: "a.spec.ts",
  line: 3,
  title: "one",
  titlePath: ["one"],
  project: "chromium",
  status: "failed",
  durationMs: 10,
  startedMs: 0,
  message: "boom",
  step: null,
  tracePath: null,
  errorContextPath: null,
  ...over,
})

test("the deciding run: tracing off unless the policy leaves the project's setting alone", () => {
  expect(firstRunTrace("on-failure-rerun")).toBe("off")
  expect(firstRunTrace("off")).toBe("off")
  expect(firstRunTrace("project")).toBeUndefined()
  expect(runnerArgs("c.mjs", { trace: "off" })).toContain("--trace=off")
  expect(runnerArgs("c.mjs", { trace: "on" })).toContain("--trace=on")
  expect(runnerArgs("c.mjs", {}).some((arg) => arg.startsWith("--trace"))).toBe(false)
})

test("the rerun selects the failed tests by file:line, in the projects they failed in, up to the limit", () => {
  const failed = [
    row({}),
    row({ testId: "a.spec.ts › one [firefox]", project: "firefox" }),
    row({ testId: "b.spec.ts › two [chromium]", file: "b.spec.ts", line: 9 }),
  ]
  expect(rerunSelection("on-failure-rerun", failed)).toMatchObject({
    files: ["a.spec.ts:3", "b.spec.ts:9"],
    extraArgs: ["--project=chromium", "--project=firefox"],
  })
  expect(rerunSelection("on-failure-rerun", failed, 1)?.rows).toHaveLength(1)
  expect(rerunSelection("on-failure-rerun", [row({ project: null })])?.extraArgs).toEqual([])
  expect(rerunSelection("on-failure-rerun", [])).toBeNull()
  expect(rerunSelection("project", failed)).toBeNull()
  expect(rerunSelection("off", failed)).toBeNull()
})

test("rerun outcomes are matched by test id; anything the rerun did not finish is not_run", () => {
  const failed = [
    row({}),
    row({ testId: "b" }),
    row({ testId: "c" }),
    row({ testId: "d" }),
    row({ testId: "e" }),
  ]
  const outcomes = rerunOutcomes(failed, [
    row({ status: "passed" }),
    row({ testId: "b", status: "timed_out" }),
    row({ testId: "c", status: "skipped" }),
    row({ testId: "d", status: "interrupted" }),
    row({ testId: "someone else", status: "passed" }),
  ])
  expect([...outcomes]).toEqual([
    ["a.spec.ts › one [chromium]", "passed"],
    ["b", "failed"],
    ["c", "not_run"],
    ["d", "not_run"],
    ["e", "not_run"],
  ])
  expect([...rerunOutcomes(failed.slice(0, 1), null).values()]).toEqual(["not_run"])
})

test("artifacts: the deciding run's win, the rerun fills the gaps", () => {
  const merged = mergeArtifacts(
    new Map([
      ["a", { trace: null, consoleErrors: null, domSnapshot: "/1/ctx.md" }],
      ["b", { trace: "/1/b.zip", consoleErrors: ["x"], domSnapshot: null }],
    ]),
    new Map([
      ["a", { trace: "/2/a.zip", consoleErrors: [], domSnapshot: "/2/ctx.md" }],
      ["b", { trace: "/2/b.zip", consoleErrors: [], domSnapshot: null }],
    ]),
  )
  expect(merged.get("a")).toEqual({ trace: "/2/a.zip", consoleErrors: [], domSnapshot: "/1/ctx.md" })
  expect(merged.get("b")).toEqual({ trace: "/1/b.zip", consoleErrors: ["x"], domSnapshot: null })
})
