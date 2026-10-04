// Dev command: run a Playwright project's suite through the warm pool, once or repeatedly.
//
//   npm run suite -- <projectPath> [--env KEY=VALUE]... [--repeat N] [--workers N] [--timeout MS]
//                    [--hold] [--report] [files or file:line ...] [-- extra playwright args]
//
// --report prints the last run's full result (Playwright JSON included) as JSON on stdout.
// --hold keeps the pool up after the runs until the process gets SIGINT/SIGTERM.
import { loadavg } from "node:os"
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { PoolLive, type RunResult, runSuite } from "../src/index.ts"

const argv = process.argv.slice(2)
const env: Record<string, string> = {}
const files: Array<string> = []
let extraArgs: Array<string> = []
let projectPath: string | undefined
let repeat = 1
let workers: string | undefined
let testTimeoutMs: number | undefined
let hold = false
let printReport = false
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i] as string
  if (arg === "--") {
    extraArgs = argv.slice(i + 1)
    break
  }
  if (arg === "--env") {
    const pair = argv[++i] ?? ""
    const at = pair.indexOf("=")
    if (at < 1) throw new Error(`--env wants KEY=VALUE, got "${pair}"`)
    env[pair.slice(0, at)] = pair.slice(at + 1)
  } else if (arg === "--repeat") repeat = Number(argv[++i])
  else if (arg === "--workers") workers = argv[++i]
  else if (arg === "--timeout") testTimeoutMs = Number(argv[++i])
  else if (arg === "--hold") hold = true
  else if (arg === "--report") printReport = true
  else if (projectPath === undefined) projectPath = arg
  else files.push(arg)
}
if (projectPath === undefined) {
  console.error("usage: npm run suite -- <projectPath> [--env K=V] [--repeat N] [files...]")
  process.exit(64)
}
const spec = { path: projectPath, env }
const options = {
  files,
  extraArgs,
  ...(workers !== undefined ? { workers } : {}),
  ...(testTimeoutMs !== undefined ? { testTimeoutMs } : {}),
}

const log = (line: string) => console.error(line)
const quantile = (values: ReadonlyArray<number>, q: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? Number.NaN
}
const line = (index: number, r: RunResult) => {
  const s = r.report?.stats
  const t = r.timings
  return (
    `run ${index}: exit ${r.exitCode}` +
    ` passed ${s?.expected ?? "?"} failed ${s?.unexpected ?? "?"} skipped ${s?.skipped ?? "?"}` +
    ` | pool wait ${t.poolWaitMs} ms${r.pool.cold ? " (cold)" : ""}` +
    ` | spawn->begin ${t.spawnToBeginMs} | spawn->first test ${t.spawnToFirstTestMs}` +
    ` | spawn->end ${t.spawnToEndMs} | spawn->exit ${t.spawnToExitMs} | total ${t.totalMs} ms` +
    ` | workers ${r.workers} | load ${loadavg()[0]?.toFixed(1)}`
  )
}

const program = Effect.gen(function* () {
  const results: Array<RunResult> = []
  for (let i = 1; i <= repeat; i++) {
    const result = yield* runSuite(spec, options)
    results.push(result)
    log(line(i, result))
  }
  const warm = results.filter((r) => !r.pool.cold)
  if (warm.length > 1) {
    for (const [name, pick] of [
      ["spawn->begin", (r: RunResult) => r.timings.spawnToBeginMs ?? Number.NaN],
      ["spawn->first test", (r: RunResult) => r.timings.spawnToFirstTestMs ?? Number.NaN],
      ["spawn->exit", (r: RunResult) => r.timings.spawnToExitMs],
      ["total", (r: RunResult) => r.timings.totalMs],
    ] as const) {
      const values = warm.map(pick)
      log(
        `warm runs (${warm.length}) ${name}: p50 ${quantile(values, 0.5)} ms, max ${Math.max(...values)} ms`,
      )
    }
  }
  const last = results.at(-1)
  if (printReport && last) console.log(JSON.stringify(last, null, 2))
  if (last?.report === null) log(`no report; runner output: ${last.runDir}/output.log`)
  if (hold) {
    log(`holding the pool (pid ${process.pid}); stop with SIGINT or SIGTERM`)
    yield* Effect.never
  }
}).pipe(
  Effect.provide(PoolLive),
  Effect.catch((error) =>
    Effect.sync(() => {
      console.error(`cook: ${error._tag}: ${JSON.stringify(error, null, 2)}`)
      process.exitCode = 2
    }),
  ),
)

NodeRuntime.runMain(program)
