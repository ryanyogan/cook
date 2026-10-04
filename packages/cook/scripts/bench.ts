// Dev command: the same suite through the warm pool and through plain `playwright test`, taking
// turns, so both see the same machine load. The plain run uses the project's config as it is and
// finds the pool's web server already running; that only works for a project whose webServer
// allows `reuseExistingServer`. Both runs carry the same two reporters, so the timings compare.
//
//   node scripts/bench.ts <projectPath> [--env KEY=VALUE]... [--runs N]
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { loadavg, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { PoolLive, resolveProject, runSuite } from "../src/index.ts"

const argv = process.argv.slice(2)
const env: Record<string, string> = {}
let path: string | undefined
let runs = 10
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--env") {
    const [key, ...value] = (argv[++i] ?? "").split("=")
    if (key) env[key] = value.join("=")
  } else if (argv[i] === "--runs") runs = Number(argv[++i])
  else path = argv[i]
}
if (!path) throw new Error("usage: bench.ts <projectPath> [--env K=V] [--runs N]")
const spec = { path, env }
const reporter = fileURLToPath(new URL("../assets/reporter.cjs", import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), "cook-bench-"))

interface Sample {
  readonly firstTestMs: number
  readonly exitMs: number
  readonly failed: number
}

const plain = (cli: string, cwd: string, index: number) =>
  Effect.promise<Sample>(
    () =>
      new Promise((resolve) => {
        const events = join(scratch, `events-${index}.json`)
        const report = join(scratch, `report-${index}.json`)
        const startedAt = Date.now()
        const child = spawn(process.execPath, [cli, "test", `--reporter=${reporter},json`], {
          cwd,
          env: { ...process.env, ...env, COOK_EVENTS_FILE: events, PLAYWRIGHT_JSON_OUTPUT_NAME: report },
          stdio: "ignore",
        })
        child.on("exit", () => {
          const exitMs = Date.now() - startedAt
          const first = JSON.parse(readFileSync(events, "utf8")).firstTestAt
          const failed = JSON.parse(readFileSync(report, "utf8")).stats.unexpected
          resolve({ firstTestMs: first - startedAt, exitMs, failed })
        })
      }),
  )

const quantile = (values: ReadonlyArray<number>, q: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
}
const summary = (name: string, samples: ReadonlyArray<Sample>) => {
  const first = samples.map((s) => s.firstTestMs)
  const exit = samples.map((s) => s.exitMs)
  console.log(
    `${name} (${samples.length} runs): spawn->first test p50 ${quantile(first, 0.5)} max ${Math.max(...first)} ms` +
      ` | spawn->exit p50 ${quantile(exit, 0.5)} max ${Math.max(...exit)} ms`,
  )
}

NodeRuntime.runMain(
  Effect.gen(function* () {
    const project = yield* resolveProject(spec)
    const warmUp = yield* runSuite(spec)
    console.log(
      `warm-up run (cold pool): pool wait ${warmUp.timings.poolWaitMs} ms, total ${warmUp.timings.totalMs} ms`,
    )
    const pool: Array<Sample> = []
    const plainRuns: Array<Sample> = []
    for (let i = 1; i <= runs; i++) {
      const r = yield* runSuite(spec)
      const a: Sample = {
        firstTestMs: r.timings.spawnToFirstTestMs ?? Number.NaN,
        exitMs: r.timings.totalMs,
        failed: r.report?.stats.unexpected ?? -1,
      }
      const b = yield* plain(project.playwrightCli, project.configDir, i)
      pool.push(a)
      plainRuns.push(b)
      console.log(
        `${i}: pool first test ${a.firstTestMs} exit ${a.exitMs} failed ${a.failed}${r.pool.cold ? " COLD" : ""}` +
          ` | plain first test ${b.firstTestMs} exit ${b.exitMs} failed ${b.failed} | load ${loadavg()[0]?.toFixed(1)}`,
      )
    }
    summary("pool ", pool)
    summary("plain", plainRuns)
  }).pipe(Effect.provide(PoolLive)),
)
