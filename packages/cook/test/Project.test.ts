import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import {
  loadsAsEsm,
  type Project,
  parseWebServerDump,
  resolveProject,
  wrapperPath,
  wrapperSource,
} from "../src/Project.ts"

/** A directory that looks like a project with Playwright installed. Nothing is run from it. */
const fakeProject = (options: {
  readonly type?: "module"
  readonly config: string
  readonly source: string
}) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cook-project-")))
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fake", type: options.type }))
  const playwright = join(root, "node_modules", "@playwright", "test")
  mkdirSync(playwright, { recursive: true })
  writeFileSync(
    join(playwright, "package.json"),
    JSON.stringify({ name: "@playwright/test", version: "9.8.7" }),
  )
  writeFileSync(join(playwright, "cli.js"), "")
  writeFileSync(join(root, options.config), options.source)
  return root
}

const config = `{
  testDir: "./tests",
  use: { baseURL: "http://127.0.0.1:" + (process.env.FAKE_PORT ?? "1") },
  webServer: { command: "start it", port: 4999, cwd: "app", env: { A: "b" }, reuseExistingServer: true },
}`

afterEach(() => {
  delete process.env.COOK_WEBSERVER_DUMP
})

describe("resolveProject", () => {
  it("finds the config, the project's Playwright and its version", async () => {
    const root = fakeProject({
      type: "module",
      config: "playwright.config.js",
      source: `export default ${config}`,
    })
    const project = await Effect.runPromise(resolveProject({ path: root, env: { X: "1" } }))
    expect(project).toEqual({
      root,
      configFile: join(root, "playwright.config.js"),
      configDir: root,
      playwrightVersion: "9.8.7",
      playwrightCli: join(root, "node_modules", "@playwright", "test", "cli.js"),
      esm: true,
      env: { X: "1" },
    } satisfies Project)
  })

  it("fails with a reason when there is no config or no Playwright", async () => {
    const empty = mkdtempSync(join(tmpdir(), "cook-empty-"))
    const noConfig = await Effect.runPromise(Effect.flip(resolveProject({ path: empty })))
    expect(noConfig.reason).toMatch(/no Playwright config/)
    writeFileSync(join(empty, "playwright.config.js"), "module.exports = {}")
    const noPlaywright = await Effect.runPromise(Effect.flip(resolveProject({ path: empty })))
    expect(noPlaywright.reason).toMatch(/not installed/)
  })

  it("decides the module format like Node does", () => {
    const esm = fakeProject({ type: "module", config: "playwright.config.ts", source: "" })
    const cjs = fakeProject({ config: "playwright.config.ts", source: "" })
    expect(loadsAsEsm(join(esm, "playwright.config.ts"))).toBe(true)
    expect(loadsAsEsm(join(cjs, "playwright.config.ts"))).toBe(false)
    expect(loadsAsEsm(join(esm, "playwright.config.cjs"))).toBe(false)
    expect(loadsAsEsm(join(cjs, "playwright.config.mts"))).toBe(true)
  })
})

describe("wrapper config", () => {
  const load = async (root: string) => {
    const project = await Effect.runPromise(resolveProject({ path: root }))
    const wrapper = wrapperPath(project)
    writeFileSync(wrapper, wrapperSource(project))
    const dump = join(root, "dump.json")
    process.env.COOK_WEBSERVER_DUMP = dump
    const exported = project.esm
      ? (await import(pathToFileURL(wrapper).href)).default
      : createRequire(import.meta.url)(wrapper)
    return { exported, entries: parseWebServerDump(readFileSync(dump, "utf8")), root }
  }
  const expectStripped = ({ exported, entries, root }: Awaited<ReturnType<typeof load>>) => {
    expect(exported).toEqual({ testDir: "./tests", use: { baseURL: "http://127.0.0.1:1" } })
    expect(entries).toEqual([
      { command: "start it", port: 4999, cwd: join(root, "app"), env: { A: "b" }, reuseExistingServer: true },
    ])
  }

  it("re-exports an ES module config without webServer and dumps the entries", async () => {
    expectStripped(
      await load(
        fakeProject({ type: "module", config: "playwright.config.js", source: `export default ${config}` }),
      ),
    )
  })

  it("does the same for a CommonJS config", async () => {
    expectStripped(
      await load(fakeProject({ config: "playwright.config.js", source: `module.exports = ${config}` })),
    )
  })

  it("reports no entries for a config without webServer", async () => {
    const { exported, entries } = await load(
      fakeProject({ config: "playwright.config.js", source: `module.exports = { testDir: "./e2e" }` }),
    )
    expect(exported).toEqual({ testDir: "./e2e" })
    expect(entries).toEqual([])
  })

  it("rejects a dump Playwright itself would reject", () => {
    expect(() => parseWebServerDump(`[{"command":"x","url":"http://a","port":1}]`)).toThrow(
      /both url and port/,
    )
    expect(() => parseWebServerDump(`[{"url":"http://a"}]`)).toThrow(/no command/)
    expect(() => parseWebServerDump(`{}`)).toThrow(/not an array/)
  })
})
