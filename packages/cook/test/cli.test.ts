import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { freePort } from "../src/os.ts"

const cli = fileURLToPath(new URL("../bin/cook.mjs", import.meta.url))
const cook = (args: ReadonlyArray<string>, port: number) =>
  spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, COOK_PORT: String(port) },
  })

test("the client imports nothing but Node built-ins, and the daemon only to start it", () => {
  const source = readFileSync(cli, "utf8")
  const imported = [...source.matchAll(/(?:from|import\()\s*"([^"]+)"/g)].map((match) => match[1])
  expect(imported.filter((name) => !name?.startsWith("node:"))).toEqual(["../src/daemon.ts"])
})

test("without a daemon: run and status exit 2 with a reason on stderr and nothing on stdout; stop is a no-op", async () => {
  const port = await freePort()
  for (const args of [["run", ".", "--json"], ["status"]]) {
    const result = cook(args, port)
    expect([result.status, result.stdout]).toEqual([2, ""])
    expect(result.stderr).toContain(`no daemon on 127.0.0.1:${port}`)
  }
  expect(cook(["stop"], port).status).toBe(0)
  expect(cook(["bogus"], port).status).toBe(2)
})

test("start --detach fails at once when the port belongs to something else", async () => {
  const port = await freePort()
  const other = createServer((_request, response) => response.end("not cook")).listen(port, "127.0.0.1")
  try {
    // spawnSync would block this process's server, so run the client asynchronously.
    const { spawn } = await import("node:child_process")
    const startedAt = Date.now()
    const child = spawn(process.execPath, [cli, "start", "--detach"], {
      env: { ...process.env, COOK_PORT: String(port) },
    })
    let stderr = ""
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    const code = await new Promise((resolve) => child.once("exit", resolve))
    expect(code).toBe(2)
    expect(stderr).toContain(`port ${port} is in use by something that is not a cook daemon`)
    expect(Date.now() - startedAt).toBeLessThan(3000)
  } finally {
    other.close()
  }
})
