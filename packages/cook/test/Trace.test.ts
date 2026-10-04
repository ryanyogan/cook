import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateRawSync } from "node:zlib"
import { expect, test } from "vitest"
import { consoleErrorsFromEvents, consoleErrorsFromTrace, readZip } from "../src/Trace.ts"

/** A minimal zip writer for the test: stored or deflated entries, no checksums (readZip ignores them). */
const zip = (entries: ReadonlyArray<{ name: string; data: string; deflate?: boolean }>): Buffer => {
  const locals: Array<Buffer> = []
  const central: Array<Buffer> = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const raw = Buffer.from(entry.data)
    const body = entry.deflate ? deflateRawSync(raw) : raw
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(entry.deflate ? 8 : 0, 10)
    header.writeUInt32LE(body.length, 20)
    header.writeUInt32LE(raw.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    central.push(header, name)
    offset += 30 + name.length + body.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const events = [
  { type: "console", messageType: "debug", text: "[vite] connected." },
  { type: "console", messageType: "error", text: "Failed to load resource: 500" },
  { type: "frame-snapshot", snapshot: { html: 'something "console" inside' } },
  { type: "event", method: "pageError", params: { error: { error: { message: "boom is not defined" } } } },
  { type: "event", method: "page", params: {} },
]
  .map((event) => JSON.stringify(event))
  .join("\n")

test("console errors and uncaught page errors are picked out of trace events", () => {
  expect(consoleErrorsFromEvents(events)).toEqual([
    "Failed to load resource: 500",
    "uncaught: boom is not defined",
  ])
  expect(consoleErrorsFromEvents("not json\n\n")).toEqual([])
})

test("reads them from a trace zip, stored or deflated; an unreadable trace gives null", () => {
  const dir = mkdtempSync(join(tmpdir(), "cook-trace-"))
  try {
    const archive = zip([
      { name: "resources/a.json", data: "{}" },
      { name: "0-trace.trace", data: events, deflate: true },
      {
        name: "1-trace.trace",
        data: JSON.stringify({ type: "console", messageType: "error", text: "second" }),
      },
      { name: "0-trace.network", data: '{"type":"console","messageType":"error","text":"not a trace file"}' },
    ])
    expect(readZip(archive, () => true).map((f) => f.name)).toHaveLength(4)
    const file = join(dir, "trace.zip")
    writeFileSync(file, archive)
    expect(consoleErrorsFromTrace(file)).toEqual([
      "Failed to load resource: 500",
      "uncaught: boom is not defined",
      "second",
    ])
    writeFileSync(file, "garbage")
    expect(consoleErrorsFromTrace(file)).toBeNull()
    expect(consoleErrorsFromTrace(join(dir, "missing.zip"))).toBeNull()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
