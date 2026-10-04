import { existsSync, readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path"
import { Effect } from "effect"
import { ProjectError } from "./errors.ts"

/** What a caller says about the project to run. */
export interface ProjectSpec {
  /** Directory of the project (where its Playwright config lives). */
  readonly path: string
  /** Config file, absolute or relative to `path`. Default: `playwright.config.*` in `path`. */
  readonly config?: string
  /**
   * Extra environment for everything Cook starts for this project: evaluating the config, the web
   * servers and the runner. A project whose config reads its port from the environment gets it here.
   */
  readonly env?: Readonly<Record<string, string>>
}

export interface Project {
  readonly root: string
  readonly configFile: string
  readonly configDir: string
  /** Version of the Playwright installed in the project, e.g. "1.63.0". Keys the browser server. */
  readonly playwrightVersion: string
  /** The project's own Playwright command line script, run with `node`. */
  readonly playwrightCli: string
  /** Whether Playwright loads the config as an ES module. Decides the wrapper config's format. */
  readonly esm: boolean
  readonly env: Readonly<Record<string, string>>
}

const configNames = ["ts", "js", "mts", "mjs", "cts", "cjs"].map((ext) => `playwright.config.${ext}`)

/** Same rule as Playwright and Node: the extension, else the nearest package.json `type`. */
export const loadsAsEsm = (file: string): boolean => {
  const ext = extname(file)
  if (ext === ".mjs" || ext === ".mts") return true
  if (ext === ".cjs" || ext === ".cts") return false
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const manifest = join(dir, "package.json")
    if (existsSync(manifest)) {
      try {
        return JSON.parse(readFileSync(manifest, "utf8")).type === "module"
      } catch {
        return false
      }
    }
    if (dirname(dir) === dir) return false
  }
}

export const resolveProject = (spec: ProjectSpec): Effect.Effect<Project, ProjectError> =>
  Effect.try({
    try: () => {
      const root = realpathSync(resolve(spec.path))
      const configFile = spec.config
        ? isAbsolute(spec.config)
          ? spec.config
          : join(root, spec.config)
        : configNames.map((name) => join(root, name)).find((file) => existsSync(file))
      if (!configFile || !existsSync(configFile)) {
        throw new Error(`no Playwright config found (looked for ${spec.config ?? "playwright.config.*"})`)
      }
      const require = createRequire(configFile)
      let manifestPath: string | undefined
      for (const name of ["@playwright/test", "playwright"]) {
        try {
          manifestPath = require.resolve(`${name}/package.json`)
          break
        } catch {}
      }
      if (!manifestPath) {
        throw new Error("@playwright/test is not installed in the project (run its package install)")
      }
      const playwrightCli = join(dirname(manifestPath), "cli.js")
      if (!existsSync(playwrightCli)) throw new Error(`${playwrightCli} does not exist`)
      const playwrightVersion = String(JSON.parse(readFileSync(manifestPath, "utf8")).version)
      return {
        root,
        configFile,
        configDir: dirname(configFile),
        playwrightVersion,
        playwrightCli,
        esm: loadsAsEsm(configFile),
        env: spec.env ?? {},
      }
    },
    catch: (error) =>
      new ProjectError({ path: spec.path, reason: error instanceof Error ? error.message : String(error) }),
  })

/** One `webServer` entry of the project's config, as the wrapper config reports it. */
export interface WebServerEntry {
  readonly command: string
  readonly url?: string
  readonly port?: number
  /** Absolute. */
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeout?: number
  readonly reuseExistingServer?: boolean
  readonly name?: string
}

export const wrapperPath = (project: Project): string =>
  join(project.configDir, `.cook-playwright.config.${project.esm ? "mjs" : "cjs"}`)

/**
 * Source of the wrapper config. It sits next to the project's config, so every path Playwright
 * resolves against the config directory is unchanged. It re-exports the project's config without
 * `webServer` (Cook keeps those servers running itself, so the runner must neither start nor stop
 * them) and, when COOK_WEBSERVER_DUMP names a file, writes the removed entries there as JSON.
 */
export const wrapperSource = (project: Project): string => {
  const target = JSON.stringify(`./${basename(project.configFile)}`)
  const load = project.esm
    ? `import * as loaded from ${target}\nimport fs from "node:fs"\nimport path from "node:path"\nlet config = loaded.default ?? loaded`
    : `const fs = require("node:fs")\nconst path = require("node:path")\nlet config = require(${target})`
  return `// Generated by Cook (warm Playwright runner). Not part of the project; safe to delete.
${load}
if (config && typeof config === "object" && "default" in config) config = config.default
const dir = ${JSON.stringify(project.configDir)}
const { webServer, ...rest } = config ?? {}
if (process.env.COOK_WEBSERVER_DUMP) {
  const list = Array.isArray(webServer) ? webServer : webServer ? [webServer] : []
  const entries = list.map((entry) => ({
    command: entry.command,
    url: entry.url,
    port: entry.port,
    cwd: entry.cwd ? path.resolve(dir, entry.cwd) : dir,
    env: entry.env,
    timeout: entry.timeout,
    reuseExistingServer: entry.reuseExistingServer,
    name: entry.name,
  }))
  fs.writeFileSync(process.env.COOK_WEBSERVER_DUMP, JSON.stringify(entries))
}
${project.esm ? "export default rest" : "module.exports = rest"}
`
}

/** Validates what the wrapper dumped. */
export const parseWebServerDump = (json: string): ReadonlyArray<WebServerEntry> => {
  const raw: unknown = JSON.parse(json)
  if (!Array.isArray(raw)) throw new Error("webServer dump is not an array")
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || typeof entry.command !== "string") {
      throw new Error(`webServer[${index}] has no command`)
    }
    if (entry.url !== undefined && entry.port !== undefined) {
      throw new Error(`webServer[${index}] sets both url and port`)
    }
    return entry as WebServerEntry
  })
}
