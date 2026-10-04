#!/usr/bin/env node
// The `cook` command. A thin client of the daemon: plain JavaScript, Node built-ins only. It must
// never import the engine or Effect, so that `cook run` costs little more than starting Node.
// (`cook start` is the exception: it becomes, or spawns, the daemon.)
import { request } from "node:http"

const usage = `usage:
  cook start [--detach]                  start the daemon (in the foreground unless --detach)
  cook run [PATH] [TEST...] [--json]     run a project's Playwright suite; TEST is a file or file:line
           [--env KEY=VALUE]... [--timeout MS] [--workers N] [--config FILE]
           [--trace on-failure-rerun|project|off]   default on-failure-rerun: tracing off, then the
                                         failed tests once more with tracing on (never changes the
                                         verdict); project: the project's own trace setting
           [--order longest-first|project]          default longest-first, from recorded durations
           [--serve auto|dev|build]      default auto: web servers named in the project's
                                         cook.config.json are built and served from the build
                                         (rebuilt when its inputs changed); dev: the Playwright
                                         config's own webServer command; build: fail if not set up
  cook status [--json]                   daemon and pool status
  cook stop                              stop the daemon and everything it started
environment: COOK_PORT (4050), COOK_HOME (~/.cook), COOK_START_TIMEOUT_MS (15000)
exit codes of run: 0 pass, 1 fail, 2 error`

const port = Number(process.env.COOK_PORT ?? 4050)
const invokedAt = Number(process.env.COOK_INVOKED_AT_MS) || Math.round(performance.timeOrigin)

const fail = (message) => {
  process.stderr.write(`cook: ${message}\n`)
  process.exit(2)
}

/** One HTTP exchange with the daemon. Resolves with null when nothing listens on the port. */
const call = (method, path, body) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          connection: "close",
          ...(payload !== undefined
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        const chunks = []
        res.on("data", (chunk) => chunks.push(chunk))
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        )
        res.on("error", reject)
      },
    )
    req.on("error", (error) => (error.code === "ECONNREFUSED" ? resolve(null) : reject(error)))
    req.end(payload)
  })

const status = async () => {
  const response = await call("GET", "/api/status")
  if (response === null) return null
  try {
    const body = JSON.parse(response.text)
    return body.schema === "cook.status/1" ? body : undefined
  } catch {
    return undefined
  }
}

const notRunning = () => fail(`no daemon on 127.0.0.1:${port}. Start one with: cook start --detach`)

const commands = {
  async start(args) {
    if (!args.includes("--detach")) {
      await import("../src/daemon.ts")
      return
    }
    const { spawn } = await import("node:child_process")
    const { mkdirSync, openSync, readFileSync } = await import("node:fs")
    const { homedir } = await import("node:os")
    const { join } = await import("node:path")
    const { fileURLToPath } = await import("node:url")
    const running = await status()
    if (running) {
      process.stdout.write(`cook daemon already running (pid ${running.pid}, port ${port})\n`)
      return
    }
    if (running === undefined) fail(`port ${port} is in use by something that is not a cook daemon`)
    const home = process.env.COOK_HOME ?? join(homedir(), ".cook")
    mkdirSync(home, { recursive: true })
    const logFile = join(home, "daemon.log")
    const log = openSync(logFile, "a")
    const startedAt = Date.now()
    const child = spawn(process.execPath, [fileURLToPath(new URL("../src/daemon.ts", import.meta.url))], {
      detached: true,
      stdio: ["ignore", log, log],
    })
    let exited = null
    child.once("exit", (code, signal) => {
      exited = signal ?? code
    })
    child.once("error", (error) => {
      exited = error.message
    })
    const logTail = () => {
      try {
        return readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-15).join("\n")
      } catch {
        return ""
      }
    }
    const deadline = startedAt + Number(process.env.COOK_START_TIMEOUT_MS ?? 15_000)
    for (;;) {
      if (exited !== null)
        fail(`the daemon exited (${exited}) before it was ready. Last lines of ${logFile}:\n${logTail()}`)
      const now = await status().catch(() => null)
      if (now && now.pid === child.pid) {
        child.unref()
        process.stdout.write(
          `cook daemon ready in ${Date.now() - startedAt} ms (pid ${child.pid}, port ${port}, log ${logFile})\n`,
        )
        process.exit(0)
      }
      if (Date.now() > deadline) {
        // Our own child, by pid.
        child.kill("SIGTERM")
        fail(
          `the daemon was not ready after ${deadline - startedAt} ms and was stopped. Last lines of ${logFile}:\n${logTail()}`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  },

  async run(args) {
    const { existsSync, statSync } = await import("node:fs")
    const { resolve } = await import("node:path")
    const body = { path: undefined, files: [], env: {}, client_started_ms: invokedAt }
    let json = false
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      const value = () => args[++i] ?? fail(`${arg} wants a value`)
      if (arg === "--json") json = true
      else if (arg === "--env") {
        const pair = value()
        const at = pair.indexOf("=")
        if (at < 1) fail(`--env wants KEY=VALUE, got "${pair}"`)
        body.env[pair.slice(0, at)] = pair.slice(at + 1)
      } else if (arg === "--timeout") body.timeout_ms = Number(value())
      else if (arg === "--workers") body.workers = value()
      else if (arg === "--config") body.config = value()
      else if (arg === "--trace") {
        body.trace = value()
        if (!["on-failure-rerun", "project", "off"].includes(body.trace)) {
          fail(`--trace wants on-failure-rerun, project or off, got "${body.trace}"`)
        }
      } else if (arg === "--order") {
        body.order = value()
        if (!["longest-first", "project"].includes(body.order)) {
          fail(`--order wants longest-first or project, got "${body.order}"`)
        }
      } else if (arg === "--serve") {
        body.serve = value()
        if (!["auto", "dev", "build"].includes(body.serve)) {
          fail(`--serve wants auto, dev or build, got "${body.serve}"`)
        }
      } else if (arg.startsWith("--")) fail(`unknown option ${arg}\n${usage}`)
      else if (
        body.path === undefined &&
        body.files.length === 0 &&
        existsSync(arg) &&
        statSync(arg).isDirectory()
      ) {
        body.path = resolve(arg)
      } else body.files.push(arg)
    }
    body.path ??= process.cwd()
    const response = await call("POST", `/api/runs${json ? "" : "?format=text"}`, body)
    if (response === null) notRunning()
    const code = Number(response.headers["x-cook-exit-code"])
    if (response.status !== 200 || !Number.isInteger(code))
      fail(`the daemon answered ${response.status}: ${response.text}`)
    // The exit code is set, not forced, so that a long verdict is written out completely.
    process.stdout.write(response.text.endsWith("\n") ? response.text : `${response.text}\n`)
    process.exitCode = code
  },

  async status(args) {
    const body = await status()
    if (body === null) notRunning()
    if (body === undefined) fail(`port ${port} answers, but not as a cook daemon`)
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(body, null, 2)}\n`)
      return
    }
    const lines = [
      `cook daemon pid ${body.pid}, port ${body.port}, up ${Math.round(body.uptime_ms / 1000)} s, home ${body.home}`,
    ]
    for (const project of body.projects) {
      lines.push(`  ${project.path}: ${project.running ? "running" : "idle"}, ${project.queued} queued`)
      for (const server of project.servers) {
        lines.push(
          `    ${server.name}: ${server.state}${server.accepting ? "" : ", not accepting"}` +
            (server.mode !== undefined
              ? server.mode === "build"
                ? `, serving a build (${server.detail})`
                : `, dev serving (${server.detail})`
              : "") +
            (server.pid !== null ? `, pid ${server.pid}, started ${server.starts}x` : ""),
        )
      }
    }
    if (body.projects.length === 0) lines.push("  no project has been run yet")
    process.stdout.write(`${lines.join("\n")}\n`)
  },

  async stop() {
    const before = await status()
    if (before === null) {
      process.stdout.write(`no cook daemon on port ${port}\n`)
      return
    }
    if (before === undefined) fail(`port ${port} answers, but not as a cook daemon`)
    await call("POST", "/api/stop", {})
    const alive = () => {
      try {
        process.kill(before.pid, 0)
        return true
      } catch {
        return false
      }
    }
    const deadline = Date.now() + 15_000
    while (alive()) {
      if (Date.now() > deadline) fail(`daemon ${before.pid} was asked to stop but is still running`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    process.stdout.write(`cook daemon ${before.pid} stopped\n`)
  },
}

const [name, ...args] = process.argv.slice(2)
const command = Object.hasOwn(commands, name ?? "") ? commands[name] : undefined
if (command === undefined) {
  process.stderr.write(`${usage}\n`)
  process.exit(name === undefined || name === "help" || name === "--help" ? 0 : 2)
}
command(args).catch((error) => fail(error?.message ?? String(error)))
