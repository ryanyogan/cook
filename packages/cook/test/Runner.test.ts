import { describe, expect, it } from "vitest"
import { runnerArgs, timingsFrom } from "../src/Runner.ts"

describe("runnerArgs", () => {
  it("always turns retries off, caps each test at 10 s and writes the JSON report", () => {
    const args = runnerArgs("/p/.cook-playwright.config.mjs")
    expect(args.slice(0, 5)).toEqual([
      "test",
      "--config",
      "/p/.cook-playwright.config.mjs",
      "--retries=0",
      "--timeout=10000",
    ])
    expect(args[5]).toMatch(/^--reporter=\/.*assets\/reporter\.cjs,json$/)
    expect(args).toHaveLength(6)
  })

  it("puts options before the file filters", () => {
    const args = runnerArgs("/c", {
      files: ["e2e/a.spec.ts:12"],
      testTimeoutMs: 500,
      workers: 2,
      extraArgs: ["--grep", "@slow"],
    })
    expect(args.slice(4)).toEqual([
      "--timeout=500",
      args[5],
      "--workers=2",
      "--grep",
      "@slow",
      "e2e/a.spec.ts:12",
    ])
  })
})

describe("timingsFrom", () => {
  const marks = { calledAt: 1000, spawnedAt: 1010, exitedAt: 6010 }

  it("measures the reporter's events from the spawn", () => {
    expect(timingsFrom(marks, { beginAt: 1310, firstTestAt: 1610, endAt: 5910 }, 6015)).toEqual({
      poolWaitMs: 10,
      spawnToBeginMs: 300,
      spawnToFirstTestMs: 600,
      spawnToEndMs: 4900,
      spawnToExitMs: 5000,
      totalMs: 5015,
    })
  })

  it("leaves what never happened as null", () => {
    expect(timingsFrom(marks, null, 6010)).toMatchObject({
      spawnToBeginMs: null,
      spawnToFirstTestMs: null,
      spawnToEndMs: null,
    })
    expect(timingsFrom(marks, { beginAt: 1310, firstTestAt: null }, 6010).spawnToFirstTestMs).toBeNull()
  })
})
