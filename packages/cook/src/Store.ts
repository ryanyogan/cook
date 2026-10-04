import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { TestRow } from "./Report.ts"
import type { Verdict } from "./Verdict.ts"

const migrations: ReadonlyArray<string> = [
  `CREATE TABLE runs (
     id               TEXT PRIMARY KEY,
     project_path     TEXT NOT NULL,
     status           TEXT NOT NULL,          -- pass | fail | error
     selection_reason TEXT NOT NULL,          -- all | explicit
     selected         INTEGER NOT NULL,
     passed           INTEGER NOT NULL,
     failed           INTEGER NOT NULL,
     duration_ms      INTEGER NOT NULL,
     error_reason     TEXT,
     started_at       TEXT NOT NULL,          -- ISO 8601, when the daemon received the request
     verdict          TEXT NOT NULL           -- the cook.verdict/1 document as JSON
   );
   CREATE INDEX runs_project_started ON runs (project_path, started_at);
   CREATE TABLE test_results (
     id           INTEGER PRIMARY KEY,
     run_id       TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
     project_path TEXT NOT NULL,
     test_id      TEXT NOT NULL,              -- file, describe titles, title [project]: survives line changes
     file         TEXT NOT NULL,
     line         INTEGER NOT NULL,
     title        TEXT NOT NULL,
     project      TEXT,                       -- Playwright project name
     status       TEXT NOT NULL,              -- passed | failed | timed_out | skipped | interrupted
     duration_ms  INTEGER NOT NULL,
     started_ms   INTEGER                     -- start, ms after the first test of the run started
   );
   CREATE INDEX test_results_run ON test_results (run_id);
   CREATE INDEX test_results_test ON test_results (project_path, test_id);`,
]

export interface RunSummary {
  readonly id: string
  readonly project_path: string
  readonly status: string
  readonly selection_reason: string
  readonly selected: number
  readonly passed: number
  readonly failed: number
  readonly duration_ms: number
  readonly error_reason: string | null
  readonly started_at: string
}

export interface StoredTestResult {
  readonly run_id: string
  readonly project_path: string
  readonly test_id: string
  readonly file: string
  readonly line: number
  readonly title: string
  readonly project: string | null
  readonly status: string
  readonly duration_ms: number
  readonly started_ms: number | null
}

export interface Store {
  /** Stores a run and every test result of it, in one transaction. */
  readonly record: (verdict: Verdict, rows: ReadonlyArray<TestRow>, startedAt: Date) => void
  /** The stored verdict as it was returned, or null. */
  readonly verdict: (runId: string) => unknown | null
  readonly recent: (limit: number, projectPath?: string) => ReadonlyArray<RunSummary>
  readonly testResults: (runId: string) => ReadonlyArray<StoredTestResult>
  /** Number of tests in the project's latest full run that ended as pass or fail; null if none. */
  readonly knownTests: (projectPath: string) => number | null
  readonly close: () => void
}

/** Opens (and migrates) the SQLite database. `:memory:` gives a private one for tests. */
export const openStore = (file: string): Store => {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;")
  const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version)
  for (let i = version; i < migrations.length; i++) {
    db.exec(`BEGIN; ${migrations[i]}; PRAGMA user_version = ${i + 1}; COMMIT;`)
  }
  const insertRun = db.prepare(
    `INSERT INTO runs (id, project_path, status, selection_reason, selected, passed, failed, duration_ms,
                       error_reason, started_at, verdict) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertTest = db.prepare(
    `INSERT INTO test_results (run_id, project_path, test_id, file, line, title, project, status,
                               duration_ms, started_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const summaryColumns =
    "id, project_path, status, selection_reason, selected, passed, failed, duration_ms, error_reason, started_at"
  return {
    record: (verdict, rows, startedAt) => {
      db.exec("BEGIN")
      try {
        insertRun.run(
          verdict.run_id,
          verdict.path,
          verdict.status,
          verdict.selection_reason,
          verdict.selected,
          verdict.counts.passed,
          verdict.counts.failed,
          Math.round(verdict.duration_ms),
          verdict.error?.reason ?? null,
          startedAt.toISOString(),
          JSON.stringify(verdict),
        )
        for (const row of rows) {
          insertTest.run(
            verdict.run_id,
            verdict.path,
            row.testId,
            row.file,
            row.line,
            row.title,
            row.project,
            row.status,
            row.durationMs,
            row.startedMs,
          )
        }
        db.exec("COMMIT")
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      }
    },
    verdict: (runId) => {
      const row = db.prepare("SELECT verdict FROM runs WHERE id = ?").get(runId) as
        | { verdict: string }
        | undefined
      return row === undefined ? null : JSON.parse(row.verdict)
    },
    recent: (limit, projectPath) =>
      (projectPath === undefined
        ? db
            .prepare(`SELECT ${summaryColumns} FROM runs ORDER BY started_at DESC, rowid DESC LIMIT ?`)
            .all(limit)
        : db
            .prepare(
              `SELECT ${summaryColumns} FROM runs WHERE project_path = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`,
            )
            .all(projectPath, limit)
      ).map((row) => ({ ...row })) as unknown as ReadonlyArray<RunSummary>,
    testResults: (runId) =>
      db
        .prepare(
          `SELECT run_id, project_path, test_id, file, line, title, project, status, duration_ms, started_ms
           FROM test_results WHERE run_id = ? ORDER BY id`,
        )
        .all(runId)
        .map((row) => ({ ...row })) as unknown as ReadonlyArray<StoredTestResult>,
    knownTests: (projectPath) => {
      const row = db
        .prepare(
          `SELECT selected FROM runs WHERE project_path = ? AND selection_reason = 'all' AND status != 'error'
           ORDER BY started_at DESC, rowid DESC LIMIT 1`,
        )
        .get(projectPath) as { selected: number } | undefined
      return row === undefined ? null : Number(row.selected)
    },
    close: () => db.close(),
  }
}
