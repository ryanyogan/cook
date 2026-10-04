import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { freePort, isAlive, portUsed, tcpAccepts, urlAvailable, waitUntil } from "../src/os.ts"

const server = createServer((request, response) => {
  response.statusCode = Number(request.url?.slice(1)) || 200
  response.end("ok")
})
let port = 0

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => new Promise((resolve) => server.close(resolve)))

describe("readiness probes", () => {
  it("sees a listening port and a closed one", async () => {
    expect(await tcpAccepts("127.0.0.1", port)).toBe(true)
    expect(await portUsed(port)).toBe(true)
    expect(await tcpAccepts("127.0.0.1", await freePort())).toBe(false)
  })

  it("accepts the statuses Playwright accepts for webServer.url", async () => {
    const check = (status: number) => urlAvailable(`http://127.0.0.1:${port}/${status}`)
    expect(await check(200)).toBe(true)
    expect(await check(302)).toBe(true)
    expect(await check(403)).toBe(true)
    expect(await check(404)).toBe(false)
    expect(await check(500)).toBe(false)
    expect(await urlAvailable(`http://127.0.0.1:${await freePort()}/`)).toBe(false)
  })

  it("waitUntil stops at the deadline and on abort", async () => {
    let calls = 0
    expect(await waitUntil(async () => ++calls === 3, { timeoutMs: 1000, intervalMs: 1 })).toBe(true)
    expect(await waitUntil(async () => false, { timeoutMs: 30, intervalMs: 5 })).toBe(false)
    expect(await waitUntil(async () => false, { timeoutMs: 5000, signal: AbortSignal.abort() })).toBe(false)
  })

  it("isAlive tells a live pid from a dead one", () => {
    expect(isAlive(process.pid)).toBe(true)
    expect(isAlive(2 ** 22 + 12345)).toBe(false)
  })
})
