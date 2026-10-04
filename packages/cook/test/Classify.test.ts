import { expect, test } from "vitest"
import { classify, type ServerIdentity, type ServerSnapshot, staleReady } from "../src/Classify.ts"

const browser: ServerIdentity = {
  kind: "browser_server",
  name: "browser server (Playwright 1.63.0)",
  pid: 10,
  starts: 1,
}
const web: ServerIdentity = {
  kind: "web_server",
  name: "webServer[0]",
  pid: 20,
  starts: 1,
  detail: "npm run dev",
}
const before = [browser, web]
const ok = (identity: ServerIdentity, over: Partial<ServerSnapshot> = {}): ServerSnapshot => ({
  ...identity,
  state: "ready",
  accepting: true,
  ...over,
})

test("the same servers, ready and accepting: nothing died", () => {
  expect(classify(before, [ok(browser), ok(web)])).toBeNull()
})

test("still listed as ready but the port is closed: dead, the exit just has not been noticed", () => {
  expect(classify(before, [ok(browser, { accepting: false }), ok(web)])).toEqual({
    reason: "browser_server_down",
    server: "browser server (Playwright 1.63.0)",
    why: "not_accepting_at_run_end",
  })
  expect(classify(before, [ok(browser), ok(web, { accepting: false })])).toEqual({
    reason: "web_server_down",
    server: "web server webServer[0] (`npm run dev`)",
    why: "not_accepting_at_run_end",
  })
})

test("restarting or failed at the end of the run", () => {
  const restarting = ok(browser, { state: "starting", pid: null, starts: null, accepting: false })
  expect(classify(before, [restarting, ok(web)])?.why).toBe("not_ready_at_run_end")
  expect(classify(before, [ok(browser), ok(web, { state: "failed", pid: null })])?.reason).toBe(
    "web_server_down",
  )
})

test("already restarted and healthy again: another process than the run started with", () => {
  expect(classify(before, [ok(browser, { pid: 11, starts: 2 }), ok(web)])?.why).toBe("restarted_during_run")
  expect(classify(before, [ok(browser), ok(web, { pid: 21, starts: 2 })])).toMatchObject({
    reason: "web_server_down",
    why: "restarted_during_run",
  })
})

test("gone from the pool; the browser server is named first when both died", () => {
  expect(classify(before, [ok(browser)])).toMatchObject({ reason: "web_server_down", why: "gone_at_run_end" })
  expect(classify(before, [])?.reason).toBe("browser_server_down")
  expect(classify(before, [ok(web, { accepting: false }), ok(browser, { accepting: false })])?.reason).toBe(
    "browser_server_down",
  )
})

test("an adopted web server has no pid; it is judged by its port alone", () => {
  const adopted: ServerIdentity = { kind: "web_server", name: "webServer[0]", pid: null, starts: null }
  expect(classify([browser, adopted], [ok(browser), ok(adopted, { state: "adopted" })])).toBeNull()
  expect(
    classify([browser, adopted], [ok(browser), ok(adopted, { state: "adopted", accepting: false })])?.why,
  ).toBe("not_accepting_at_run_end")
})

test("staleReady: a ready server whose port is closed", () => {
  expect(staleReady([ok(browser), ok(web)])).toBe(false)
  expect(staleReady([ok(browser, { accepting: false })])).toBe(true)
  expect(staleReady([ok(browser, { state: "starting", accepting: false })])).toBe(false)
})
