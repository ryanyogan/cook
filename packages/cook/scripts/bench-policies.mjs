// Compares the order and trace policies on one project through `cook run --json`, taking turns.
// usage: node scripts/bench-policies.mjs <project> [--env K=V]... [--runs 8] [--warmup 2] [--out file.jsonl]
// Needs a running daemon (COOK_PORT, COOK_HOME as for `cook`).
import { spawnSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const cli = fileURLToPath(new URL("../bin/cook.mjs", import.meta.url))
const args = process.argv.slice(2)
const project = args[0]
const passthrough = []
let runs = 8
let warmup = 2
let out = null
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--runs") runs = Number(args[++i])
  else if (args[i] === "--warmup") warmup = Number(args[++i])
  else if (args[i] === "--out") out = args[++i]
  else passthrough.push(args[i])
}
const configs = {
  a_project_order_project_trace: ["--order", "project", "--trace", "project"],
  b_longest_first_only: ["--order", "longest-first", "--trace", "project"],
  c_trace_policy_only: ["--order", "project", "--trace", "on-failure-rerun"],
  d_both: ["--order", "longest-first", "--trace", "on-failure-rerun"],
}
const once = (name, flags) => {
  const load = Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0])
  const startedAt = performance.now()
  const result = spawnSync(process.execPath, [cli, "run", project, "--json", ...passthrough, ...flags], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  const wallMs = Math.round(performance.now() - startedAt)
  let verdict = null
  try {
    verdict = JSON.parse(result.stdout)
  } catch {}
  return {
    config: name,
    wallMs,
    exit: result.status,
    load,
    status: verdict?.status ?? null,
    failed: verdict?.counts?.failed ?? null,
    passed: verdict?.counts?.passed ?? null,
    failures: (verdict?.failures ?? []).map((f) => `${f.test} rerun=${f.diagnostic_rerun}`),
    rerunMs: verdict?.timing?.diagnostic_rerun_ms ?? null,
    slowestMs: verdict?.timing?.slowest_test_ms ?? null,
    testsMs: verdict?.timing?.tests_ms ?? null,
    applied: verdict?.scheduling?.applied ?? null,
    error: verdict?.error?.reason ?? null,
  }
}
for (let i = 0; i < warmup; i++) {
  const row = once("warmup", configs.a_project_order_project_trace)
  console.log(JSON.stringify(row))
}
const rows = []
for (let i = 0; i < runs; i++) {
  for (const [name, flags] of Object.entries(configs)) {
    const row = once(name, flags)
    rows.push(row)
    console.log(JSON.stringify(row))
    if (out) appendFileSync(out, `${JSON.stringify(row)}\n`)
  }
}
const p50 = (list) => [...list].sort((x, y) => x - y)[Math.floor((list.length - 1) / 2)]
for (const name of Object.keys(configs)) {
  const mine = rows.filter((row) => row.config === name)
  const walls = mine.map((row) => row.wallMs)
  const first = mine.map((row) => row.wallMs - (row.rerunMs ?? 0))
  const reruns = mine.flatMap((row) => (row.rerunMs === null ? [] : [row.rerunMs]))
  const loads = mine.map((row) => row.load)
  console.log(
    `${name}: wall p50 ${p50(walls)} min ${Math.min(...walls)} max ${Math.max(...walls)} ms | without rerun p50 ${p50(first)} max ${Math.max(...first)} | ` +
      `runs ${mine.length}, failing runs ${mine.filter((row) => row.exit !== 0).length}, failed tests ${mine.reduce((n, row) => n + (row.failed ?? 0), 0)}, errors ${mine.filter((row) => row.status === "error" || row.status === null).length} | ` +
      `reruns ${reruns.length}${reruns.length ? ` (${reruns.join(", ")} ms)` : ""} | load ${Math.min(...loads)} to ${Math.max(...loads)}`,
  )
}
