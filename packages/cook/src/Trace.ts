import { readFileSync } from "node:fs"
import { inflateRawSync } from "node:zlib"

/**
 * The files of a zip archive whose name passes `want`, uncompressed. Reads the central directory;
 * handles stored and deflated entries, which is all Playwright writes. No zip64.
 */
export const readZip = (
  archive: Buffer,
  want: (name: string) => boolean,
): ReadonlyArray<{ readonly name: string; readonly data: Buffer }> => {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (end < 0) throw new Error("not a zip archive")
  const count = archive.readUInt16LE(end + 10)
  let at = archive.readUInt32LE(end + 16)
  const files: Array<{ readonly name: string; readonly data: Buffer }> = []
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(at) !== 0x02014b50) throw new Error("bad zip central directory")
    const method = archive.readUInt16LE(at + 10)
    const compressedSize = archive.readUInt32LE(at + 20)
    const nameLength = archive.readUInt16LE(at + 28)
    const extraLength = archive.readUInt16LE(at + 30)
    const commentLength = archive.readUInt16LE(at + 32)
    const local = archive.readUInt32LE(at + 42)
    const name = archive.toString("utf8", at + 46, at + 46 + nameLength)
    if (want(name)) {
      const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28)
      const raw = archive.subarray(start, start + compressedSize)
      files.push({ name, data: method === 0 ? raw : inflateRawSync(raw) })
    }
    at += 46 + nameLength + extraLength + commentLength
  }
  return files
}

const maxLines = 50

/** Console `error` messages and uncaught page errors recorded in the events of a Playwright trace. */
export const consoleErrorsFromEvents = (ndjson: string): ReadonlyArray<string> => {
  const lines: Array<string> = []
  for (const line of ndjson.split("\n")) {
    // Cheap filter first: traces hold many large events that are of no interest here.
    if (!line.includes('"console"') && !line.includes('"pageError"')) continue
    try {
      const event = JSON.parse(line) as {
        type?: string
        messageType?: string
        text?: string
        method?: string
        params?: { error?: { error?: { message?: string }; value?: unknown } }
      }
      if (event.type === "console" && event.messageType === "error" && typeof event.text === "string") {
        lines.push(event.text)
      } else if (event.type === "event" && event.method === "pageError") {
        const error = event.params?.error
        lines.push(`uncaught: ${error?.error?.message ?? String(error?.value ?? "unknown error")}`)
      }
    } catch {}
    if (lines.length >= maxLines) break
  }
  return lines
}

/** Null when the trace cannot be read. */
export const consoleErrorsFromTrace = (traceZip: string): ReadonlyArray<string> | null => {
  try {
    const files = readZip(readFileSync(traceZip), (name) => name.endsWith(".trace"))
    return files.flatMap((file) => consoleErrorsFromEvents(file.data.toString("utf8"))).slice(0, maxLines)
  } catch {
    return null
  }
}
