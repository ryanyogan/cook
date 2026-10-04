// Process guard. Plain JavaScript on purpose: it is started with `node` from anywhere, no type stripping.
//
//   node guard.mjs <logFile> <shell:0|1> <command> [args...]
//
// Runs the command with stdout and stderr appended to <logFile> and exits with its exit code.
// The guard is the leader of its own process group (the parent spawns it detached) and holds a pipe
// to its parent on stdin. When that pipe closes (the parent stopped, crashed or was killed with
// SIGKILL) or the guard gets SIGTERM/SIGINT/SIGHUP, it kills every descendant, including descendants
// that moved to another process group, then exits. That is what keeps a dead daemon from leaving
// servers behind.
import { execFileSync, spawn } from "node:child_process"
import { existsSync, openSync, readdirSync, readFileSync } from "node:fs"

const [logFile, shellFlag, command, ...args] = process.argv.slice(2)
if (!logFile || !command) {
  process.stderr.write("usage: guard.mjs <logFile> <shell:0|1> <command> [args...]\n")
  process.exit(64)
}
const graceMs = Number(process.env.COOK_GUARD_GRACE_MS ?? 2000)

/** pid -> parent pid for every process we can see. /proc when present, `ps` otherwise. */
function parentTable() {
  const table = new Map()
  if (existsSync("/proc/self/stat")) {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8")
        // "pid (comm) state ppid ..."; comm may contain spaces and parentheses.
        const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
        table.set(Number(name), Number(rest[1]))
      } catch {}
    }
    return table
  }
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
  for (const line of out.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (pid) table.set(pid, ppid)
  }
  return table
}

function descendants(root) {
  const table = parentTable()
  const children = new Map()
  for (const [pid, ppid] of table) {
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
  }
  const found = []
  const queue = [root]
  while (queue.length > 0) {
    for (const pid of children.get(queue.shift()) ?? []) {
      found.push(pid)
      queue.push(pid)
    }
  }
  return found
}

function signal(pids, sig) {
  for (const pid of pids) {
    try {
      process.kill(pid, sig)
    } catch {}
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const out = openSync(logFile, "a")
const child = spawn(command, args, { stdio: ["ignore", out, out], shell: shellFlag === "1" })

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  const pids = descendants(process.pid)
  signal(pids, "SIGTERM")
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline && pids.some(alive)) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  // Processes started while we were waiting are caught by the second look.
  signal([...new Set([...pids, ...descendants(process.pid)])].filter(alive), "SIGKILL")
  process.exit(143)
}

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, stop)
process.stdin.on("end", stop)
process.stdin.on("close", stop)
process.stdin.on("error", stop)
process.stdin.resume()

child.on("error", (error) => {
  process.stderr.write(`guard: cannot start ${command}: ${error.message}\n`)
  process.exit(127)
})
child.on("exit", (code, sig) => {
  if (stopping) return
  stopping = true
  // The command is gone; anything it left in our process group goes with it.
  process.removeAllListeners("SIGTERM")
  process.on("SIGTERM", () => {})
  try {
    process.kill(-process.pid, "SIGTERM")
  } catch {}
  setTimeout(() => process.exit(code ?? (sig ? 128 : 1)), 50)
})
