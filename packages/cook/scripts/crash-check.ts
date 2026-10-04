// Manual check of the pool's crash handling against a real project (not a unit test: it boots the
// project's servers). Kills the browser server, then the first web server, with SIGKILL while idle
// and shows that the next run works and that the killed process was replaced.
//
//   node scripts/crash-check.ts <projectPath> [--env KEY=VALUE]... [file ...]
import { execFileSync } from "node:child_process"
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { PoolLive, type RunResult, runSuite } from "../src/index.ts"

const argv = process.argv.slice(2)
const env: Record<string, string> = {}
const rest: Array<string> = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--env") {
    const [key, ...value] = (argv[++i] ?? "").split("=")
    if (key) env[key] = value.join("=")
  } else rest.push(argv[i] as string)
}
const [path, ...files] = rest
if (!path) throw new Error("usage: crash-check.ts <projectPath> [--env K=V] [file ...]")

const childrenOf = (pid: number) =>
  execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map(Number)
const show = (label: string, r: RunResult) =>
  console.log(
    `${label}: exit ${r.exitCode}, passed ${r.report?.stats.expected}, failed ${r.report?.stats.unexpected}, ` +
      `pool wait ${r.timings.poolWaitMs} ms, cold ${r.pool.cold}, browser server pid ${r.pool.browserServer.pid} ` +
      `starts ${r.pool.browserServer.starts}, web servers ${JSON.stringify(
        r.pool.webServers.map((s) => ("pid" in s ? { pid: s.pid, starts: s.starts } : "adopted")),
      )}`,
  )

NodeRuntime.runMain(
  Effect.gen(function* () {
    const first = yield* runSuite({ path, env }, { files })
    show("first run", first)

    const browserPid = childrenOf(first.pool.browserServer.pid)[0] as number
    process.kill(browserPid, "SIGKILL")
    console.log(`killed browser server process ${browserPid}`)
    yield* Effect.sleep("300 millis")
    const second = yield* runSuite({ path, env }, { files })
    show("after browser server kill", second)

    const web = second.pool.webServers[0]
    if (web && "pid" in web) {
      const webPid = childrenOf(web.pid)[0] as number
      process.kill(webPid, "SIGKILL")
      console.log(`killed web server process ${webPid}`)
      yield* Effect.sleep("300 millis")
      show("after web server kill", yield* runSuite({ path, env }, { files }))
    }
    console.log(`pool pid ${process.pid}; holding for 60 s so it can be killed from outside`)
    yield* Effect.sleep("60 seconds")
  }).pipe(Effect.provide(PoolLive)),
)
