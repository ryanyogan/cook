// Compares dev serving and build serving on one project through `cook run --json`, taking turns.
// usage: node scripts/bench-serve.mjs <project> [--env K=V]... [--runs 8] [--workers 8] [--out file.jsonl] [TEST...]
// Needs a running daemon (COOK_PORT, COOK_HOME as for `cook`) and a cook.config.json in the project.
// Changing the mode restarts the project's web servers, so every round first makes one untimed
// full run in the new mode (a dev server also has to transform its modules again after a restart);
// the timed runs after it are warm, and their `server_restart_ms` is checked to be null.
import { spawnSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const cli = fileURLToPath(new URL("../bin/cook.mjs", import.meta.url))
const args = process.argv.slice(2)
const project = args[0]
const passthrough = []
let runs = 8
let workers = "8"
let out = null
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--runs") runs = Number(args[++i])
  else if (args[i] === "--workers") workers = args[++i]
  else if (args[i] === "--out") out = args[++i]
  else passthrough.push(args[i])
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
  const row = {
    config: name,
    wallMs,
    exit: result.status,
    load,
    status: verdict?.status ?? null,
    passed: verdict?.counts?.passed ?? null,
    failed: verdict?.counts?.failed ?? null,
    failures: (verdict?.failures ?? []).map((f) => `${f.test} rerun=${f.diagnostic_rerun}`),
    rerunMs: verdict?.timing?.diagnostic_rerun_ms ?? null,
    checkMs: verdict?.timing?.build_check_ms ?? null,
    buildMs: verdict?.timing?.build_ms ?? null,
    restartMs: verdict?.timing?.server_restart_ms ?? null,
    overheadMs: verdict?.timing?.overhead_ms ?? null,
    slowestMs: verdict?.timing?.slowest_test_ms ?? null,
    modes: (verdict?.serving?.servers ?? []).map((s) => s.mode).join(","),
    error: verdict?.error?.reason ?? null,
  }
  console.log(JSON.stringify(row))
  if (out) appendFileSync(out, `${JSON.stringify(row)}\n`)
  return row
}
const groups = {
  dev: {
    dev_default_workers: ["--serve", "dev"],
    [`dev_${workers}_workers`]: ["--serve", "dev", "--workers", workers],
  },
  build: {
    build_default_workers: ["--serve", "build"],
    [`build_${workers}_workers`]: ["--serve", "build", "--workers", workers],
  },
}
const rows = []
for (let i = 0; i < runs; i++) {
  for (const [mode, configs] of Object.entries(groups)) {
    once(`switch_to_${mode}`, ["--serve", mode])
    for (const [name, flags] of Object.entries(configs)) rows.push(once(name, flags))
  }
}
const p50 = (list) => [...list].sort((x, y) => x - y)[Math.floor((list.length - 1) / 2)]
for (const name of Object.values(groups).flatMap((configs) => Object.keys(configs))) {
  const mine = rows.filter((row) => row.config === name)
  const walls = mine.map((row) => row.wallMs)
  const first = mine.map((row) => row.wallMs - (row.rerunMs ?? 0))
  const loads = mine.map((row) => row.load)
  const checks = mine.flatMap((row) => (row.checkMs === null ? [] : [row.checkMs]))
  console.log(
    `${name}: wall p50 ${p50(walls)} min ${Math.min(...walls)} max ${Math.max(...walls)} ms | without rerun p50 ${p50(first)} max ${Math.max(...first)} | ` +
      `runs ${mine.length}, failing runs ${mine.filter((row) => row.exit !== 0).length}, failed tests ${mine.reduce((n, row) => n + (row.failed ?? 0), 0)}, errors ${mine.filter((row) => row.status === "error" || row.status === null).length} | ` +
      `not warm ${mine.filter((row) => row.restartMs !== null || row.buildMs !== null).length} | ` +
      (checks.length ? `freshness check p50 ${p50(checks)} max ${Math.max(...checks)} ms | ` : "") +
      `load ${Math.min(...loads)} to ${Math.max(...loads)}`,
  )
}
