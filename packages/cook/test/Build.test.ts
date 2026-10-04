import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, test } from "vitest"
import {
  type BuildRecord,
  ConfigProblem,
  decideFreshness,
  type FileStat,
  hashFile,
  loadCookConfig,
  parseCookConfig,
  planServing,
  racyWindowMs,
  type Scan,
  scanFiles,
  stampInputs,
  stampOutputs,
} from "../src/Build.ts"
import { buildVerdict, summary } from "../src/Verdict.ts"

const valid = {
  workers: { build: 8 },
  webServers: [
    { build: "npm run build", serve: "npm run preview", inputs: ["src", "package.json"], outputs: ["dist"] },
  ],
}
const parse = (value: unknown) => parseCookConfig(JSON.stringify(value))

test("a valid file decodes, and a project without the file has no config", () => {
  expect(parse(valid).webServers?.[0]?.serve).toBe("npm run preview")
  expect(parse({})).toEqual({})
  const dir = mkdtempSync(join(tmpdir(), "cook-config-"))
  expect(loadCookConfig(dir)).toBeNull()
  writeFileSync(join(dir, "cook.config.json"), JSON.stringify(valid))
  expect(loadCookConfig(dir)?.workers?.build).toBe(8)
  rmSync(dir, { recursive: true })
})

test("a bad file is refused with a message that names the problem", () => {
  const server = valid.webServers[0]
  const cases: ReadonlyArray<readonly [unknown, RegExp]> = [
    ["{ not json", /not valid JSON/],
    [{ webServers: [{ build: "b", serve: "s" }] }, /inputs/],
    [{ webServers: [{ ...server, build: 3 }] }, /build/],
    [{ webServers: [{ ...server, serve: " " }] }, /webServers\[0\]\.serve is empty/],
    [{ webServers: [{ ...server, inputs: [] }] }, /inputs is empty/],
    [{ webServers: [{ ...server, inputs: ["../other"] }] }, /inside the project/],
    [{ webServers: [{ ...server, outputs: ["/abs/dist"] }] }, /inside the project/],
    [{ webServers: [{ ...server, entry: -1 }] }, /entry must be an index/],
    [{ webServers: [server, server] }, /named twice/],
    [{ webServers: [{ ...server, buildTimeoutMs: 0 }] }, /buildTimeoutMs/],
    [{ workers: { build: 0 } }, /workers\.build/],
    [{ workers: { dev: "many" } }, /workers\.dev/],
  ]
  for (const [value, message] of cases) {
    const text = typeof value === "string" ? value : JSON.stringify(value)
    expect(() => parseCookConfig(text), text).toThrow(ConfigProblem)
    expect(() => parseCookConfig(text), text).toThrow(message)
  }
})

const entries = [{ command: "npm run dev" }, { command: "npm run api", name: "api" }]

test("planServing: auto follows the file, dev and build force", () => {
  const config = parse(valid)
  expect(planServing(entries, null, "auto").servers.map((s) => s.mode)).toEqual(["dev", "dev"])
  const auto = planServing(entries, config, "auto")
  expect(auto.servers.map((s) => [s.mode, s.command])).toEqual([
    ["build", "npm run preview"],
    ["dev", "npm run api"],
  ])
  expect(auto.workers).toBe(8)
  const dev = planServing(entries, config, "dev")
  expect(dev.servers.map((s) => s.command)).toEqual(["npm run dev", "npm run api"])
  expect(dev.workers).toBeUndefined()
  expect(dev.key).not.toBe(auto.key)
  expect(planServing(entries, config, "build").key).toBe(auto.key)
  const named = parse({ webServers: [{ ...valid.webServers[0], entry: "api" }] })
  expect(planServing(entries, named, "auto").servers.map((s) => s.mode)).toEqual(["dev", "build"])
})

test("planServing refuses a forced build without a description, and an entry that does not exist", () => {
  expect(() => planServing(entries, null, "build")).toThrow(/no cook.config.json/)
  expect(() => planServing(entries, parse({ workers: { dev: 4 } }), "build")).toThrow(ConfigProblem)
  const missing = parse({ webServers: [{ ...valid.webServers[0], entry: 5 }] })
  expect(() => planServing(entries, missing, "auto")).toThrow(/matches no webServer entry/)
  const unnamed = parse({ webServers: [{ ...valid.webServers[0], entry: "web" }] })
  expect(() => planServing(entries, unnamed, "dev")).toThrow(/matches no webServer entry/)
  // A project with no webServer at all and no file is unchanged.
  expect(planServing([], null, "auto").servers).toEqual([])
})

// ---- the freshness decision, with the file system stubbed --------------------------------------

const old = 1_000_000_000_000 // ms, long before `now`
const now = old + 60_000
const stat = (size: number, ms: number): FileStat => ({
  size,
  mtimeNs: `${ms}000000`,
  ctimeNs: `${ms}000000`,
})
const scanOf = (files: Record<string, FileStat>): Scan => new Map(Object.entries(files))
const content: Record<string, string> = { "src/a.ts": "A", "src/b.ts": "B" }
const hashOf = (path: string) => `h:${content[path]}`
const inputs = scanOf({ "src/a.ts": stat(10, old), "src/b.ts": stat(20, old) })
const outputs = scanOf({ "dist/app.js": stat(99, old + 5) })
const record: BuildRecord = {
  version: 1,
  key: "k",
  inputs: stampInputs(inputs, hashOf, now),
  outputs: stampOutputs(outputs),
}
const decide = (
  over: { record?: BuildRecord | null; key?: string; inputs?: Scan; outputs?: Scan | null; at?: number } = {},
  read: (path: string) => string = () => {
    throw new Error("no file may be read")
  },
) =>
  decideFreshness(
    over.record === undefined ? record : over.record,
    over.key ?? "k",
    over.inputs ?? inputs,
    over.outputs === undefined ? outputs : over.outputs,
    read,
    over.at ?? now,
  )

test("unchanged inputs are fresh without reading a single file", () => {
  expect(record.inputs["src/a.ts"]?.racy).toBe(false)
  expect(decide()).toEqual({ fresh: true, record, hashed: 0 })
})

test("stale: no record, other settings, added, removed, resized and rewritten files", () => {
  expect(decide({ record: null })).toEqual({ fresh: false, reason: "no build recorded" })
  expect(decide({ key: "other" })).toMatchObject({ fresh: false, reason: /settings changed/ })
  const added = scanOf({ ...Object.fromEntries(inputs), "src/c.ts": stat(1, old) })
  expect(decide({ inputs: added })).toEqual({ fresh: false, reason: "added: src/c.ts" })
  expect(decide({ inputs: scanOf({ "src/a.ts": stat(10, old) }) })).toEqual({
    fresh: false,
    reason: "removed: src/b.ts",
  })
  expect(decide({ inputs: scanOf({ "src/a.ts": stat(11, old + 9), "src/b.ts": stat(20, old) }) })).toEqual({
    fresh: false,
    reason: "changed: src/a.ts",
  })
  // Same size, newer timestamp, other content.
  const touched = scanOf({ "src/a.ts": stat(10, old + 9), "src/b.ts": stat(20, old) })
  expect(decide({ inputs: touched }, () => "h:other")).toEqual({ fresh: false, reason: "changed: src/a.ts" })
  expect(decide({ inputs: scanOf({}) })).toMatchObject({ fresh: false })
  expect(
    decide({ inputs: touched }, () => {
      throw new Error("EACCES")
    }),
  ).toEqual({ fresh: false, reason: "unreadable: src/a.ts" })
})

test("a file that was only touched is read once, found equal, and its new timestamps remembered", () => {
  const touched = scanOf({ "src/a.ts": stat(10, old + 9), "src/b.ts": stat(20, old) })
  const first = decide({ inputs: touched }, hashOf)
  expect(first).toMatchObject({ fresh: true, hashed: 1 })
  if (!first.fresh) throw new Error("unreachable")
  expect(first.record.inputs["src/a.ts"]?.mtimeNs).toBe(`${old + 9}000000`)
  expect(decide({ record: first.record, inputs: touched })).toMatchObject({ fresh: true, hashed: 0 })
})

test("a file recorded right after it was saved is compared by content until its timestamps can be trusted", () => {
  const justSaved = scanOf({ "src/a.ts": stat(10, now - 100), "src/b.ts": stat(20, old) })
  const racy: BuildRecord = { ...record, inputs: stampInputs(justSaved, hashOf, now) }
  expect(racy.inputs["src/a.ts"]?.racy).toBe(true)
  // Rewritten within the same clock tick: size and timestamps equal, content not.
  expect(decide({ record: racy, inputs: justSaved }, () => "h:other")).toEqual({
    fresh: false,
    reason: "changed: src/a.ts",
  })
  const soon = decide({ record: racy, inputs: justSaved, at: now + 10 }, hashOf)
  expect(soon).toMatchObject({ fresh: true, hashed: 1 })
  const later = decide({ record: racy, inputs: justSaved, at: now + racyWindowMs + 1000 }, hashOf)
  expect(later).toMatchObject({ fresh: true, hashed: 1 })
  if (!later.fresh) throw new Error("unreachable")
  expect(later.record.inputs["src/a.ts"]?.racy).toBe(false)
  expect(decide({ record: later.record, inputs: justSaved, at: now + 9000 })).toMatchObject({ hashed: 0 })
})

test("stale when the build output is missing or was changed by something else", () => {
  expect(decide({ outputs: scanOf({}) })).toEqual({ fresh: false, reason: "build output is missing" })
  expect(decide({ outputs: scanOf({ "dist/app.js": stat(98, old + 5) }) })).toMatchObject({
    fresh: false,
    reason: "build output changed outside Cook: dist/app.js",
  })
  expect(decide({ outputs: scanOf({ "dist/other.js": stat(99, old + 5) }) })).toMatchObject({ fresh: false })
  const extra = scanOf({ ...Object.fromEntries(outputs), "dist/x.js": stat(1, old) })
  expect(decide({ outputs: extra })).toMatchObject({ fresh: false, reason: /added outside Cook/ })
  expect(decide({ outputs: null })).toMatchObject({ fresh: false, reason: "declared outputs changed" })
  const without: BuildRecord = { ...record, outputs: null }
  expect(decide({ record: without, outputs: null })).toMatchObject({ fresh: true })
})

// ---- scanning a real directory (a temporary one; no app, no browser) ---------------------------

const root = mkdtempSync(join(tmpdir(), "cook-build-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const put = (path: string, text: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true })
  writeFileSync(join(root, path), text)
}

test("scanFiles walks declared files, directories and globs, and leaves out what it must", () => {
  put("src/a.ts", "a")
  put("src/deep/b.ts", "b")
  put("src/node_modules/x/index.js", "x")
  put("src/generated/skip.ts", "s")
  put("src/notes.md", "n")
  put("package.json", "{}")
  put("config/one.json", "1")
  put("dist/app.js", "built")
  symlinkSync(join(root, "src"), join(root, "src/deep/loop"))
  const scan = scanFiles(root, ["src", "package.json", "config/*.json"], ["src/generated", "**/*.md", "dist"])
  expect([...scan.keys()].sort()).toEqual(["config/one.json", "package.json", "src/a.ts", "src/deep/b.ts"])
  expect(() => scanFiles(root, ["src", "tsconfig.json"])).toThrow(/"tsconfig.json" does not exist/)
  expect(scanFiles(root, ["nothing/**"]).size).toBe(0)
})

test("end to end on real files: edit, touch, add and delete are seen; an untouched tree reads nothing", () => {
  const paths = ["src", "package.json"]
  const read = (path: string) => hashFile(join(root, path))
  const aged = new Date(Date.now() - 60_000)
  for (const path of scanFiles(root, paths).keys()) utimesSync(join(root, path), aged, aged)
  // ctime cannot be set back, so the files still look recently changed; record as if a minute later.
  const at = Date.now() + 60_000
  const built: BuildRecord = {
    version: 1,
    key: "k",
    inputs: stampInputs(scanFiles(root, paths), read, at),
    outputs: null,
  }
  const check = () => decideFreshness(built, "k", scanFiles(root, paths), null, read, at)
  expect(check()).toMatchObject({ fresh: true, hashed: 0 })
  utimesSync(join(root, "src/a.ts"), new Date(), new Date())
  expect(check()).toMatchObject({ fresh: true, hashed: 1 })
  writeFileSync(join(root, "src/a.ts"), "b")
  expect(check()).toEqual({ fresh: false, reason: "changed: src/a.ts" })
  writeFileSync(join(root, "src/a.ts"), "a")
  expect(check()).toMatchObject({ fresh: true })
  put("src/new.ts", "n")
  expect(check()).toEqual({ fresh: false, reason: "added: src/new.ts" })
  rmSync(join(root, "src/new.ts"))
  rmSync(join(root, "src/deep/b.ts"))
  expect(check()).toEqual({ fresh: false, reason: "removed: src/deep/b.ts" })
})

// ---- the verdict ------------------------------------------------------------------------------

test("the verdict keeps build time apart from overhead and test time", () => {
  const base = {
    runId: "r",
    path: "/p",
    files: [],
    capMs: 10_000,
    queueMs: 0,
    clientMs: null,
    rows: [],
    known: null,
    reproPrefix: "cook run /p",
  }
  const failed = buildVerdict({
    ...base,
    durationMs: 2100,
    timings: null,
    runner: null,
    error: { reason: "build_failed", message: "webServer[0]: `npm run build` exited with code 1" },
    serving: { requested: "auto", checkMs: 12, buildMs: 1900, restartMs: null, servers: [] },
  })
  expect(failed.status).toBe("error")
  expect(failed.timing).toMatchObject({ build_ms: 1900, build_check_ms: 12, overhead_ms: 200 })
  expect(summary(failed)).toMatch(/^ERROR build_failed after 2\.1 s \(build 1\.9 s\)/)

  const timings = {
    poolWaitMs: 2600,
    spawnToBeginMs: 300,
    spawnToFirstTestMs: 600,
    spawnToEndMs: 4600,
    spawnToExitMs: 4700,
    totalMs: 7300,
  }
  const servers = [{ name: "webServer[0]", mode: "build" as const, rebuilt: "changed: src/a.ts" }]
  const rebuilt = buildVerdict({
    ...base,
    durationMs: 7400,
    timings,
    runner: { exitCode: 0, hasReport: true, logFile: "" },
    error: { reason: "x", message: "only the timing matters here" },
    serving: { requested: "auto", checkMs: 9, buildMs: 1900, restartMs: 650, servers },
  })
  expect(rebuilt.timing).toMatchObject({
    build_ms: 1900,
    build_check_ms: 9,
    server_restart_ms: 650,
    ready_wait_ms: 700,
    overhead_ms: 7400 - 4000 - 1900,
  })
  expect(rebuilt.serving).toEqual({ requested: "auto", servers })
  const dev = buildVerdict({ ...base, durationMs: 10, timings: null, runner: null, serveRequested: "dev" })
  expect(dev.timing).toMatchObject({ build_ms: null, build_check_ms: null, server_restart_ms: null })
  expect(dev.serving).toEqual({ requested: "dev", servers: [] })
})
