import { createHash } from "node:crypto"
import { existsSync, globSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path"
import { Schema } from "effect"
import type { WebServerEntry } from "./Project.ts"

/** Name of the file a project opts in with, in the project's root. */
export const cookConfigName = "cook.config.json"

/** What a run may ask for. `auto`: build serving for the entries the project's file names, else dev. */
export const serveRequests = ["auto", "dev", "build"] as const
export type ServeRequest = (typeof serveRequests)[number]
export type ServeMode = "dev" | "build"

const Workers = Schema.Union([Schema.Number, Schema.String])

const WebServerBuild = Schema.Struct({
  /** Which `webServer` entry of the Playwright config: its index, or its `name`. Default 0. */
  entry: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  /** Shell command that builds what `serve` serves. Run in the entry's cwd with the entry's env. */
  build: Schema.String,
  /** Shell command used instead of the entry's own `command`. Same cwd, env, url/port. */
  serve: Schema.String,
  /**
   * What the build depends on: files, directories (taken recursively) or glob patterns, relative
   * to the project root. `node_modules` and `.git` inside a directory are never walked.
   */
  inputs: Schema.Array(Schema.String),
  /** Paths or glob patterns, relative to the project root, left out of `inputs`. */
  ignore: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * What the build writes (files or directories). Optional, recommended: with it Cook also rebuilds
   * when the output is missing or was changed by something else, and remembers a build across
   * daemon restarts. Outputs are never counted as inputs.
   */
  outputs: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The build is abandoned after this long. Default 300 000. */
  buildTimeoutMs: Schema.optionalKey(Schema.Number),
})
export type WebServerBuild = typeof WebServerBuild.Type

export const CookConfig = Schema.Struct({
  webServers: Schema.optionalKey(Schema.Array(WebServerBuild)),
  /** `--workers` for runs that do not say, by the mode the web servers are in. */
  workers: Schema.optionalKey(
    Schema.Struct({ dev: Schema.optionalKey(Workers), build: Schema.optionalKey(Workers) }),
  ),
})
export type CookConfig = typeof CookConfig.Type

const decodeCookConfig = Schema.decodeUnknownSync(CookConfig)

/** A problem with the project's file or with what it names. The message is for the developer. */
export class ConfigProblem extends Error {}

const validWorkers = (value: number | string): boolean =>
  typeof value === "number" ? Number.isInteger(value) && value > 0 : /^[1-9]\d*%?$/.test(value)

/** Validates the text of a `cook.config.json`. Throws `ConfigProblem` with what is wrong. */
export const parseCookConfig = (text: string, file = cookConfigName): CookConfig => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new ConfigProblem(`${file} is not valid JSON: ${error instanceof Error ? error.message : error}`)
  }
  let config: CookConfig
  try {
    config = decodeCookConfig(raw)
  } catch (error) {
    throw new ConfigProblem(`${file} is not valid: ${error instanceof Error ? error.message : error}`)
  }
  const seen = new Set<string>()
  for (const [index, server] of (config.webServers ?? []).entries()) {
    const at = `${file}: webServers[${index}]`
    if (server.build.trim() === "") throw new ConfigProblem(`${at}.build is empty`)
    if (server.serve.trim() === "") throw new ConfigProblem(`${at}.serve is empty`)
    if (server.inputs.length === 0) {
      throw new ConfigProblem(`${at}.inputs is empty: name the files and directories the build reads`)
    }
    for (const path of [...server.inputs, ...(server.outputs ?? []), ...(server.ignore ?? [])]) {
      if (path.trim() === "" || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
        throw new ConfigProblem(`${at}: "${path}" must be a path inside the project, relative to its root`)
      }
    }
    const entry = server.entry ?? 0
    if (typeof entry === "number" && (!Number.isInteger(entry) || entry < 0)) {
      throw new ConfigProblem(`${at}.entry must be an index (0, 1, ...) or the name of a webServer entry`)
    }
    if (seen.has(String(entry))) throw new ConfigProblem(`${at}.entry ${entry} is named twice`)
    seen.add(String(entry))
    if (server.buildTimeoutMs !== undefined && !(server.buildTimeoutMs > 0)) {
      throw new ConfigProblem(`${at}.buildTimeoutMs must be a positive number`)
    }
  }
  for (const [mode, value] of Object.entries(config.workers ?? {})) {
    if (value !== undefined && !validWorkers(value)) {
      throw new ConfigProblem(
        `${file}: workers.${mode} must be a positive integer or a percentage like "50%"`,
      )
    }
  }
  return config
}

/** The project's `cook.config.json`, or null when it has none (the project then runs as before). */
export const loadCookConfig = (root: string): CookConfig | null => {
  const file = join(root, cookConfigName)
  if (!existsSync(file)) return null
  return parseCookConfig(readFileSync(file, "utf8"), file)
}

/** How one `webServer` entry is served in a run. */
export interface ServerPlan {
  readonly mode: ServeMode
  /** The command to run: the entry's own in dev mode, the project's serve command in build mode. */
  readonly command: string
  /** Set in build mode. */
  readonly build?: WebServerBuild
}

export interface ServingPlan {
  readonly servers: ReadonlyArray<ServerPlan>
  /** Workers from the project's file for this mode, when it gives any. */
  readonly workers?: number | string
  /** Identifies what is running: when it changes the servers are started again. */
  readonly key: string
}

/**
 * Decides, per `webServer` entry, whether to run the entry's own command or the project's build
 * and serve commands. Pure. Throws `ConfigProblem` when the file names an entry that does not
 * exist, or when build serving is forced for a project that has not described a build.
 */
export const planServing = (
  entries: ReadonlyArray<Pick<WebServerEntry, "command" | "name">>,
  config: CookConfig | null,
  requested: ServeRequest,
): ServingPlan => {
  const builds = new Map<number, WebServerBuild>()
  for (const [position, server] of (config?.webServers ?? []).entries()) {
    const wanted = server.entry ?? 0
    const index = typeof wanted === "number" ? wanted : entries.findIndex((entry) => entry.name === wanted)
    if (index < 0 || index >= entries.length) {
      throw new ConfigProblem(
        `${cookConfigName}: webServers[${position}].entry ${JSON.stringify(wanted)} matches no webServer entry of the Playwright config (it has ${entries.length})`,
      )
    }
    if (builds.has(index)) {
      throw new ConfigProblem(`${cookConfigName}: webServer entry ${index} is described twice`)
    }
    builds.set(index, server)
  }
  if (requested === "build" && builds.size === 0) {
    throw new ConfigProblem(
      `build serving was asked for, but the project has no ${cookConfigName} with a webServers entry (build command, serve command, inputs)`,
    )
  }
  const servers = entries.map((entry, index): ServerPlan => {
    const build = builds.get(index)
    return requested !== "dev" && build !== undefined
      ? { mode: "build", command: build.serve, build }
      : { mode: "dev", command: entry.command }
  })
  const mode: ServeMode = servers.some((server) => server.mode === "build") ? "build" : "dev"
  const workers = config?.workers?.[mode]
  return {
    servers,
    ...(workers !== undefined ? { workers } : {}),
    key: JSON.stringify(servers.map((server) => [server.mode, server.command, server.build ?? null])),
  }
}

// ---------------------------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------------------------

/** What the file system says about a file without reading it. Nanoseconds as decimal strings. */
export interface FileStat {
  readonly size: number
  readonly mtimeNs: string
  readonly ctimeNs: string
}

export interface FileStamp extends FileStat {
  /** SHA-1 of the content when the build started. */
  readonly hash: string
  /**
   * The file was changed so shortly before it was recorded that a later write could carry the
   * same timestamps (coarse file system clocks). Such a file is compared by content.
   */
  readonly racy: boolean
}

/** What Cook remembers about the last successful build of one web server. */
export interface BuildRecord {
  readonly version: 1
  /** Commands, environment and declared paths the build was made with. */
  readonly key: string
  readonly inputs: Readonly<Record<string, FileStamp>>
  /** Size and mtime of every output file after the build; null when no outputs are declared. */
  readonly outputs: Readonly<Record<string, string>> | null
}

export type Scan = ReadonlyMap<string, FileStat>

const neverWalked = new Set(["node_modules", ".git"])
const hasMagic = (pattern: string) => /[*?[\]{}]/.test(pattern)
const posix = (path: string) => (sep === "/" ? path : path.split(sep).join("/"))

const statOf = (file: string): FileStat & { readonly directory: boolean } => {
  const stat = statSync(file, { bigint: true })
  return {
    size: Number(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    directory: stat.isDirectory(),
  }
}

const excluder = (root: string, ignore: ReadonlyArray<string>) => {
  const literal = ignore
    .filter((item) => !hasMagic(item))
    .map((item) => posix(relative(root, resolve(root, item))))
  const patterns = ignore.filter(hasMagic)
  return (rel: string): boolean =>
    literal.some((item) => rel === item || rel.startsWith(`${item}/`)) ||
    patterns.some((pattern) => matchesGlob(rel, pattern))
}

/**
 * Every file under the declared paths with its size and timestamps; no file is read. Paths are
 * relative to `root`, with forward slashes. Throws `ConfigProblem` for a declared path that does
 * not exist: a build whose inputs cannot be seen cannot be known to be current.
 */
export const scanFiles = (
  root: string,
  paths: ReadonlyArray<string>,
  ignore: ReadonlyArray<string> = [],
): Scan => {
  const excluded = excluder(root, ignore)
  const found = new Map<string, FileStat>()
  const visited = new Set<string>()
  const add = (absolute: string, declared: boolean): void => {
    const rel = posix(relative(root, absolute))
    if (excluded(rel)) return
    let stat: ReturnType<typeof statOf>
    try {
      stat = statOf(absolute)
    } catch {
      // A dangling link or a file removed while we walk: its absence is what gets compared.
      if (declared) throw new ConfigProblem(`${cookConfigName}: "${rel}" does not exist in ${root}`)
      return
    }
    if (!stat.directory) {
      found.set(rel, { size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs })
      return
    }
    // Links can make cycles; every real directory is walked once.
    const real = realpathSync(absolute)
    if (visited.has(real)) return
    visited.add(real)
    for (const name of readdirSync(absolute)) {
      if (!neverWalked.has(name)) add(join(absolute, name), false)
    }
  }
  for (const path of paths) {
    if (hasMagic(path)) {
      for (const match of globSync(path, { cwd: root })) add(join(root, match), false)
    } else add(resolve(root, path), true)
  }
  return found
}

export const hashFile = (file: string): string => createHash("sha1").update(readFileSync(file)).digest("hex")

/** A change this close to the moment of recording is not trusted to show in the timestamps. */
export const racyWindowMs = 2000

const newestMs = (stat: FileStat): number =>
  Number(
    (BigInt(stat.mtimeNs) > BigInt(stat.ctimeNs) ? BigInt(stat.mtimeNs) : BigInt(stat.ctimeNs)) / 1_000_000n,
  )

/** The inputs as they are now, read and hashed. Taken before the build starts. */
export const stampInputs = (
  scan: Scan,
  hashOf: (path: string) => string,
  nowMs: number,
): Record<string, FileStamp> => {
  const stamps: Record<string, FileStamp> = {}
  for (const [path, stat] of scan) {
    stamps[path] = { ...stat, hash: hashOf(path), racy: newestMs(stat) >= nowMs - racyWindowMs }
  }
  return stamps
}

export const stampOutputs = (scan: Scan): Record<string, string> => {
  const stamps: Record<string, string> = {}
  for (const [path, stat] of scan) stamps[path] = `${stat.size}:${stat.mtimeNs}`
  return stamps
}

export type Freshness =
  | {
      readonly fresh: true
      /** The record to keep: the same one, or one with newer timestamps for files only touched. */
      readonly record: BuildRecord
      /** Files that had to be read to be sure. */
      readonly hashed: number
    }
  | { readonly fresh: false; readonly reason: string }

const sameStat = (a: FileStat, b: FileStat) =>
  a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs

/**
 * Whether the last build is still what the inputs would produce. Pure: the file system is seen
 * only through `inputs`, `outputs` and `hashOf`. Anything it cannot be sure about is stale.
 *
 * A file whose size and both timestamps are as recorded is taken as unchanged without reading it
 * (ctime cannot be set back by a program, so a write always shows). A file that differs there, or
 * was recorded too soon after its last change, is read: equal content is not a change.
 */
export const decideFreshness = (
  record: BuildRecord | null,
  key: string,
  inputs: Scan,
  /** Null when no outputs are declared; otherwise the output files now. */
  outputs: Scan | null,
  hashOf: (path: string) => string,
  nowMs: number,
): Freshness => {
  if (record === null) return { fresh: false, reason: "no build recorded" }
  if (record.version !== 1) return { fresh: false, reason: "build record from another Cook version" }
  if (record.key !== key) return { fresh: false, reason: "build or serve settings changed" }
  if (inputs.size === 0) return { fresh: false, reason: "no input files found" }
  for (const path of Object.keys(record.inputs)) {
    if (!inputs.has(path)) return { fresh: false, reason: `removed: ${path}` }
  }
  let hashed = 0
  let updated: Record<string, FileStamp> | null = null
  for (const [path, stat] of inputs) {
    const known = record.inputs[path]
    if (known === undefined) return { fresh: false, reason: `added: ${path}` }
    if (!known.racy && sameStat(known, stat)) continue
    if (stat.size !== known.size) return { fresh: false, reason: `changed: ${path}` }
    let hash: string
    try {
      hash = hashOf(path)
    } catch {
      return { fresh: false, reason: `unreadable: ${path}` }
    }
    hashed += 1
    if (hash !== known.hash) return { fresh: false, reason: `changed: ${path}` }
    // Same content. Remember the timestamps, and stop reading it once they can be trusted.
    const racy = newestMs(stat) >= nowMs - racyWindowMs
    if (racy !== known.racy || !sameStat(known, stat)) {
      updated ??= { ...record.inputs }
      updated[path] = { ...stat, hash, racy }
    }
  }
  if ((record.outputs === null) !== (outputs === null)) {
    return { fresh: false, reason: "declared outputs changed" }
  }
  if (record.outputs !== null && outputs !== null) {
    if (outputs.size === 0) return { fresh: false, reason: "build output is missing" }
    const now = stampOutputs(outputs)
    for (const [path, stamp] of Object.entries(record.outputs)) {
      if (now[path] === undefined) return { fresh: false, reason: `build output removed: ${path}` }
      if (now[path] !== stamp) return { fresh: false, reason: `build output changed outside Cook: ${path}` }
    }
    for (const path of Object.keys(now)) {
      if (record.outputs[path] === undefined)
        return { fresh: false, reason: `build output added outside Cook: ${path}` }
    }
  }
  return { fresh: true, record: updated !== null ? { ...record, inputs: updated } : record, hashed }
}

/** The output files now, or an empty scan when a declared output does not exist. */
export const scanOutputs = (root: string, outputs: ReadonlyArray<string>): Scan => {
  try {
    return scanFiles(root, outputs)
  } catch {
    return new Map()
  }
}

/** Everything but the files that decides what a build produces and how it is served. */
export const buildKey = (
  build: WebServerBuild,
  entry: Pick<WebServerEntry, "cwd" | "env" | "url" | "port">,
  projectEnv: Readonly<Record<string, string>>,
): string =>
  JSON.stringify([
    build.build,
    build.serve,
    build.inputs,
    build.ignore ?? [],
    build.outputs ?? null,
    entry.cwd,
    entry.env ?? {},
    projectEnv,
  ])

export const parseBuildRecord = (text: string): BuildRecord | null => {
  try {
    const raw = JSON.parse(text) as BuildRecord
    return raw !== null && typeof raw === "object" && raw.version === 1 && typeof raw.inputs === "object"
      ? raw
      : null
  } catch {
    return null
  }
}
