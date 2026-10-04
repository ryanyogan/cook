import { mkdirSync, readFileSync } from "node:fs"
import { createConnection, createServer } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"

/** A port that was free a moment ago. The caller must cope with losing the race for it. */
export const freePort = (host = "127.0.0.1"): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once("error", reject)
    server.listen(0, host, () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })

/** True when something accepts TCP connections on host:port. */
export const tcpAccepts = (host: string, port: number, timeoutMs = 500): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
  })

/** Playwright's `webServer.port` check: something listens on the port on IPv4 or IPv6 loopback. */
export const portUsed = async (port: number): Promise<boolean> =>
  (await tcpAccepts("127.0.0.1", port)) || (await tcpAccepts("::1", port))

/**
 * Playwright's `webServer.url` check: the URL answers with a status from 200 to 403.
 * Redirects are not followed, as in Playwright.
 */
export const urlAvailable = async (url: string, timeoutMs = 1000): Promise<boolean> => {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) })
    await response.body?.cancel()
    return response.status >= 200 && response.status < 404
  } catch {
    return false
  }
}

/** Polls `probe` until it is true, the deadline passes (false) or `signal` aborts (false). */
export const waitUntil = async (
  probe: () => Promise<boolean>,
  options: { readonly timeoutMs: number; readonly intervalMs?: number; readonly signal?: AbortSignal },
): Promise<boolean> => {
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    if (options.signal?.aborted) return false
    if (await probe()) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 25))
  }
}

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Last `lines` lines of a text file, or "" when it cannot be read. */
export const tail = (file: string, lines = 20): string => {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n")
  } catch {
    return ""
  }
}

/** Cook's state directory: `COOK_HOME`, default `~/.cook`. Created on demand. */
export const cookHome = (...segments: ReadonlyArray<string>): string => {
  const dir = join(process.env.COOK_HOME ?? join(homedir(), ".cook"), ...segments)
  mkdirSync(dir, { recursive: true })
  return dir
}
