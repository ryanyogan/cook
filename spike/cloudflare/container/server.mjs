// Control server that runs inside the container. Throwaway spike code.
// Endpoints (the Worker in front does the authentication):
//   GET  /ping     liveness
//   GET  /info     cpu, memory, /dev/shm, versions, what is running
//   POST /prepare  start the dev server and a Playwright browser server, wait until both answer
//   POST /run      {files?: string[], workers?: number, connect?: boolean, grep?: string}
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import { spawn, execSync } from 'node:child_process'

const APP = '/app'
const APP_PORT = 4310
const BROWSER_PORT = 9323
const bootedAt = Date.now()
const marker = `${APP}/data/spike-marker`

let dev = null
let browser = null
let prepared = null
let running = false

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
  })
}

async function waitFor(fn, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return Date.now() - t0
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timeout after ${timeoutMs} ms`)
}

function start(cmd, args, env) {
  const child = spawn(cmd, args, { cwd: APP, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.log = ''
  const add = (d) => { child.log = (child.log + d).slice(-4000) }
  child.stdout.on('data', add)
  child.stderr.on('data', add)
  child.on('exit', (code) => { child.exited = code ?? -1 })
  return child
}

async function prepare() {
  if (prepared && dev && dev.exited === undefined && browser && browser.exited === undefined) {
    return { already: true, ...prepared }
  }
  const t0 = Date.now()
  dev = start('npm', ['run', 'dev'], { PORT: String(APP_PORT) })
  browser = start('npx', ['playwright', 'run-server', '--port', String(BROWSER_PORT), '--host', '127.0.0.1'], {})
  const [devMs, browserMs] = await Promise.all([
    waitFor(async () => {
      try { return (await fetch(`http://127.0.0.1:${APP_PORT}/api/health`)).status === 200 } catch { return false }
    }, 120_000),
    waitFor(() => portOpen(BROWSER_PORT), 120_000),
  ])
  // First page render makes Vite compile the app; measure it separately.
  const t1 = Date.now()
  const home = await fetch(`http://127.0.0.1:${APP_PORT}/`)
  await home.text()
  const firstPageMs = Date.now() - t1
  prepared = { devServerMs: devMs, browserServerMs: browserMs, firstPageMs, firstPageStatus: home.status, totalMs: Date.now() - t0 }
  return prepared
}

function runSuite({ files = [], workers, connect = true, grep }) {
  return new Promise((resolve) => {
    const args = ['playwright', 'test', '--reporter=json', '--retries=0']
    if (workers) args.push(`--workers=${workers}`)
    if (grep) args.push('--grep', grep)
    args.push(...files)
    const env = { ...process.env, PORT: String(APP_PORT) }
    if (connect) env.PW_TEST_CONNECT_WS_ENDPOINT = `ws://127.0.0.1:${BROWSER_PORT}/`
    const t0 = Date.now()
    const child = spawn('npx', args, { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('exit', (code) => {
      const wallMs = Date.now() - t0
      let report = null
      try { report = JSON.parse(out) } catch { /* reported below */ }
      const summary = { exitCode: code, wallMs, spawnedAt: t0, args, connect }
      if (report) {
        const results = []
        const walk = (suite, file) => {
          for (const spec of suite.specs ?? []) {
            for (const t of spec.tests ?? []) {
              for (const r of t.results ?? []) {
                results.push({
                  file: spec.file ?? file, line: spec.line, title: spec.title, status: r.status,
                  durationMs: r.duration, workerIndex: r.workerIndex, startedAt: Date.parse(r.startTime),
                  error: r.status === 'passed' ? undefined : (r.error?.message ?? '').slice(0, 600),
                })
              }
            }
          }
          for (const s of suite.suites ?? []) walk(s, suite.file ?? file)
        }
        for (const s of report.suites ?? []) walk(s, s.file)
        const firstStart = Math.min(...results.map((r) => r.startedAt))
        summary.stats = report.stats
        summary.configWorkers = report.config?.workers
        summary.workersUsed = new Set(results.map((r) => r.workerIndex)).size
        summary.spawnToFirstTestMs = firstStart - t0
        summary.counts = results.reduce((a, r) => { a[r.status] = (a[r.status] ?? 0) + 1; return a }, {})
        summary.failed = results.filter((r) => r.status !== 'passed')
        summary.slowest = [...results].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5)
          .map((r) => ({ file: r.file, title: r.title, durationMs: r.durationMs }))
        summary.medianTestMs = results.map((r) => r.durationMs).sort((a, b) => a - b)[Math.floor(results.length / 2)]
      } else {
        summary.stdoutTail = out.slice(-3000)
      }
      summary.stderrTail = err.slice(-1500)
      resolve({ summary, report })
    })
  })
}

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 10_000 }).trim() } catch (e) { return `ERR ${e.message}` }
}

function info() {
  const hadMarker = fs.existsSync(marker)
  return {
    bootedAt, uptimeMs: Date.now() - bootedAt,
    cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model,
    totalMemMiB: Math.round(os.totalmem() / 2 ** 20), freeMemMiB: Math.round(os.freemem() / 2 ** 20),
    loadavg: os.loadavg(),
    node: process.version, user: os.userInfo().username, kernel: os.release(),
    shm: sh('ls -ld /dev/shm 2>&1; df -h /dev/shm 2>&1 | tail -1; grep -E " /dev/shm | /tmp | /dev " /proc/mounts'),
    memInfo: sh('grep -E "MemTotal|MemAvailable|Shmem:|SwapTotal" /proc/meminfo'),
    chromeFlags: sh('ps -eo args | grep -m1 -- "--type=renderer" | tr " " "\\n" | grep -E "no-sandbox|shm|disable-gpu|headless" | sort -u | tr "\\n" " "'),
    rootDisk: sh('df -h / | tail -1'),
    cgroupCpuMax: sh('cat /sys/fs/cgroup/cpu.max'), cgroupMemMax: sh('cat /sys/fs/cgroup/memory.max'),
    markerPresent: hadMarker, markerValue: hadMarker ? fs.readFileSync(marker, 'utf8') : null,
    dbPresent: fs.existsSync(`${APP}/data/app.sqlite`),
    devRunning: !!dev && dev.exited === undefined, browserRunning: !!browser && browser.exited === undefined,
    devLogTail: dev?.log?.slice(-800), browserLogTail: browser?.log?.slice(-800),
    processes: sh('ps -eo pid,rss,args --sort=-rss | head -12'),
  }
}

async function body(req) {
  let s = ''
  for await (const c of req) s += c
  return s ? JSON.parse(s) : {}
}

http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  try {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/ping') return send(200, { ok: true, uptimeMs: Date.now() - bootedAt })
    if (url.pathname === '/info') return send(200, info())
    if (url.pathname === '/mark') {
      fs.mkdirSync(`${APP}/data`, { recursive: true })
      fs.writeFileSync(marker, String(Date.now()))
      return send(200, { written: true })
    }
    if (url.pathname === '/prepare') return send(200, await prepare())
    if (url.pathname === '/run') {
      if (running) return send(409, { error: 'a run is already in progress' })
      running = true
      try {
        const opts = await body(req)
        const receivedAt = Date.now()
        const prep = opts.connect === false && !prepared ? null : await prepare()
        const { summary, report } = await runSuite(opts)
        summary.containerUptimeAtRequestMs = receivedAt - bootedAt
        summary.prepare = prep
        summary.requestMs = Date.now() - receivedAt
        return send(200, url.searchParams.get('full') ? { summary, report } : { summary })
      } finally { running = false }
    }
    send(404, { error: 'not found' })
  } catch (e) {
    send(500, { error: String(e?.stack ?? e), devLog: dev?.log, browserLog: browser?.log })
  }
}).listen(8080, '0.0.0.0')

// The node process is PID 1 in the container. PID 1 ignores SIGTERM unless it installs a handler,
// and the Container class puts an instance to sleep by sending SIGTERM. Without this the instance
// never sleeps (measured: still running 12 minutes after a 3 minute sleepAfter).
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    dev?.kill('SIGKILL')
    browser?.kill('SIGKILL')
    process.exit(0)
  })
}
