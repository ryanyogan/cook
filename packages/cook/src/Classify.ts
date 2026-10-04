/** Who a pooled server was when a run started: enough to tell later whether it is still the same one. */
export interface ServerIdentity {
  readonly kind: "browser_server" | "web_server"
  readonly name: string
  /** Process id of the guard; null for a server Cook adopted and does not own. */
  readonly pid: number | null
  /** How often it has been started; null for an adopted server. */
  readonly starts: number | null
  /** What it is, for messages: the command of a web server. */
  readonly detail?: string
}

/** The state of a pooled server at one moment, read from the pool and from the operating system. */
export interface ServerSnapshot extends ServerIdentity {
  readonly state: "ready" | "starting" | "failed" | "adopted"
  /**
   * Whether its port accepts a TCP connection right now. The kernel closes the port the moment the
   * process dies, so this is false before the pool has noticed the exit. True when the server has
   * no port to check.
   */
  readonly accepting: boolean
}

export type DeathWhy =
  | "gone_at_run_end"
  | "not_ready_at_run_end"
  | "restarted_during_run"
  | "not_accepting_at_run_end"

export interface Death {
  readonly reason: "browser_server_down" | "web_server_down"
  readonly server: string
  readonly why: DeathWhy
}

const whyDead = (before: ServerIdentity, after: ServerSnapshot | undefined): DeathWhy | null => {
  if (after === undefined) return "gone_at_run_end"
  if (after.state === "starting" || after.state === "failed") return "not_ready_at_run_end"
  if (after.pid !== before.pid || after.starts !== before.starts) return "restarted_during_run"
  if (!after.accepting) return "not_accepting_at_run_end"
  return null
}

/**
 * Decides whether a pooled server died during a run by comparing the servers the run started with
 * to the state of the pool once the runner has exited. It looks only at state, never at the order
 * in which the runner's result and a server's exit were noticed: a dead browser makes the runner
 * finish with ordinary-looking failures within milliseconds, often before the exit is reported.
 * The browser server is checked first, because without it nothing a web server did matters.
 */
export const classify = (
  before: ReadonlyArray<ServerIdentity>,
  after: ReadonlyArray<ServerSnapshot>,
): Death | null => {
  for (const kind of ["browser_server", "web_server"] as const) {
    for (const server of before) {
      if (server.kind !== kind) continue
      const why = whyDead(
        server,
        after.find((s) => s.kind === kind && s.name === server.name),
      )
      if (why !== null) {
        const label = kind === "web_server" ? `web server ${server.name}` : server.name
        const server_ = server.detail !== undefined ? `${label} (\`${server.detail}\`)` : label
        return { reason: `${kind}_down`, server: server_, why }
      }
    }
  }
  return null
}

/** True when the pool still hands out a server whose port is closed: its exit is not noticed yet. */
export const staleReady = (snapshot: ReadonlyArray<ServerSnapshot>): boolean =>
  snapshot.some((server) => server.state === "ready" && !server.accepting)

export const describeDeath = (death: Death): string =>
  `${death.server} died during the run (${death.why.replaceAll("_", " ")}). ` +
  "The test results of this run are not trustworthy and are not reported. The pool restarts it; run again."
