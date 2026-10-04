import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { db } from './db'
import {
  PRIORITIES,
  type ActivityEntry,
  type ExportJob,
  type FieldErrors,
  type Priority,
  type Report,
  type Result,
  type StatusFilter,
  type Task,
  type User,
} from '../lib/types'

// ---------- users and sessions ----------

function hashPassword(password: string, salt = randomBytes(8).toString('hex')) {
  const hash = scryptSync(password, salt, 32, { N: 1024 }).toString('hex')
  return `${salt}:${hash}`
}

function passwordMatches(password: string, stored: string) {
  const [salt, hash] = stored.split(':')
  const candidate = scryptSync(password, salt, 32, { N: 1024 })
  return timingSafeEqual(candidate, Buffer.from(hash, 'hex'))
}

export interface SignupInput {
  email: string
  name: string
  password: string
}

export function signup(input: SignupInput): Result<{ user: User }> {
  const email = String(input.email ?? '').trim().toLowerCase()
  const name = String(input.name ?? '').trim()
  const password = String(input.password ?? '')
  const errors: FieldErrors = {}
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter a valid email address'
  if (name.length < 1) errors.name = 'Name is required'
  if (password.length < 8) errors.password = 'Password must be at least 8 characters'
  if (Object.keys(errors).length) return { ok: false, errors }

  const existing = db().prepare('SELECT id FROM users WHERE email = ?').get(email)
  if (existing) return { ok: false, errors: { email: 'That email is already registered' } }

  const info = db()
    .prepare('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(email, name, hashPassword(password), Date.now())
  return { ok: true, user: { id: Number(info.lastInsertRowid), email, name } }
}

export function authenticate(emailInput: string, password: string): Result<{ user: User }> {
  const email = String(emailInput ?? '').trim().toLowerCase()
  const row = db()
    .prepare('SELECT id, email, name, password_hash FROM users WHERE email = ?')
    .get(email) as { id: number; email: string; name: string; password_hash: string } | undefined
  if (!row || !passwordMatches(String(password ?? ''), row.password_hash)) {
    return { ok: false, errors: { form: 'Invalid email or password' } }
  }
  return { ok: true, user: { id: row.id, email: row.email, name: row.name } }
}

export function createSession(userId: number): string {
  const token = randomBytes(24).toString('hex')
  db().prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, Date.now())
  return token
}

export function destroySession(token: string) {
  db().prepare('DELETE FROM sessions WHERE token = ?').run(token)
}

export function userForSession(token: string | undefined): User | null {
  if (!token) return null
  const row = db()
    .prepare(
      'SELECT users.id, users.email, users.name FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ?',
    )
    .get(token) as User | undefined
  return row ? { id: row.id, email: row.email, name: row.name } : null
}

export function updateName(userId: number, nameInput: string): Result<{ name: string }> {
  const name = String(nameInput ?? '').trim()
  if (name.length < 1) return { ok: false, errors: { name: 'Name is required' } }
  if (name.length > 40) return { ok: false, errors: { name: 'Name must be 40 characters or fewer' } }
  db().prepare('UPDATE users SET name = ? WHERE id = ?').run(name, userId)
  return { ok: true, name }
}

// ---------- activity ----------

function logActivity(userId: number, message: string) {
  db().prepare('INSERT INTO activity (user_id, message, created_at) VALUES (?, ?, ?)').run(userId, message, Date.now())
}

export function listActivity(userId: number): ActivityEntry[] {
  const rows = db()
    .prepare('SELECT id, message, created_at FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT 50')
    .all(userId) as Array<{ id: number; message: string; created_at: number }>
  return rows.map((r) => ({ id: r.id, message: r.message, createdAt: r.created_at }))
}

// ---------- tasks ----------

interface TaskRow {
  id: number
  title: string
  priority: Priority
  status: 'open' | 'done'
  notes: string
  created_at: number
}

const toTask = (r: TaskRow): Task => ({
  id: r.id,
  title: r.title,
  priority: r.priority,
  status: r.status,
  notes: r.notes,
  createdAt: r.created_at,
})

export interface TaskInput {
  title: string
  priority: string
  notes?: string
}

function validateTask(input: TaskInput) {
  const title = String(input.title ?? '').trim()
  const priority = String(input.priority ?? '') as Priority
  const notes = String(input.notes ?? '').trim()
  const errors: FieldErrors = {}
  if (title.length === 0) errors.title = 'Title is required'
  else if (title.length < 3) errors.title = 'Title must be at least 3 characters'
  else if (title.length > 80) errors.title = 'Title must be 80 characters or fewer'
  if (!PRIORITIES.includes(priority)) errors.priority = 'Choose a priority'
  if (notes.length > 200) errors.notes = 'Notes must be 200 characters or fewer'
  return { title, priority, notes, errors }
}

export function listTasks(userId: number, q = '', status: StatusFilter = 'all'): Task[] {
  const clauses = ['user_id = ?']
  const params: Array<string | number> = [userId]
  if (q.trim()) {
    clauses.push("title LIKE ? ESCAPE '\\'")
    params.push(`%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
  }
  if (status === 'open' || status === 'done') {
    clauses.push('status = ?')
    params.push(status)
  }
  const rows = db()
    .prepare(`SELECT * FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY id DESC`)
    .all(...params) as unknown as TaskRow[]
  return rows.map(toTask)
}

export function getTask(userId: number, id: number): Task | null {
  const row = db().prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, userId) as TaskRow | undefined
  return row ? toTask(row) : null
}

export function createTask(userId: number, input: TaskInput): Result<{ task: Task }> {
  const { title, priority, notes, errors } = validateTask(input)
  if (Object.keys(errors).length) return { ok: false, errors }
  const info = db()
    .prepare('INSERT INTO tasks (user_id, title, priority, notes, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, title, priority, notes, Date.now())
  logActivity(userId, `Created "${title}"`)
  return { ok: true, task: getTask(userId, Number(info.lastInsertRowid))! }
}

export function updateTask(userId: number, id: number, input: TaskInput): Result<{ task: Task }> {
  if (!getTask(userId, id)) return { ok: false, errors: { form: 'Task not found' } }
  const { title, priority, notes, errors } = validateTask(input)
  if (Object.keys(errors).length) return { ok: false, errors }
  db().prepare('UPDATE tasks SET title = ?, priority = ?, notes = ? WHERE id = ? AND user_id = ?').run(
    title,
    priority,
    notes,
    id,
    userId,
  )
  logActivity(userId, `Updated "${title}"`)
  return { ok: true, task: getTask(userId, id)! }
}

export function toggleTask(userId: number, id: number): Task | null {
  const task = getTask(userId, id)
  if (!task) return null
  const next = task.status === 'open' ? 'done' : 'open'
  db().prepare('UPDATE tasks SET status = ? WHERE id = ? AND user_id = ?').run(next, id, userId)
  logActivity(userId, `${next === 'done' ? 'Completed' : 'Reopened'} "${task.title}"`)
  return { ...task, status: next }
}

export function deleteTask(userId: number, id: number): boolean {
  const task = getTask(userId, id)
  if (!task) return false
  db().prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(id, userId)
  logActivity(userId, `Deleted "${task.title}"`)
  return true
}

// ---------- slow, request-bound work ----------

const IMPORT_MS_PER_LINE = 100
const REPORT_MS_PER_TASK = 150

/** One task per line, "title" or "title | priority". Each line costs real server time. */
export async function importTasks(userId: number, text: string) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 100)
  let imported = 0
  const skipped: string[] = []
  for (const line of lines) {
    await sleep(IMPORT_MS_PER_LINE)
    const [title, priority = 'normal'] = line.split('|').map((part) => part.trim())
    const result = createTask(userId, { title, priority })
    if (result.ok) imported += 1
    else skipped.push(line)
  }
  return { imported, skipped }
}

/** Aggregates task by task, the way a report over a remote billing API would. */
export async function buildReport(userId: number): Promise<Report> {
  const report: Report = { total: 0, open: 0, done: 0, byPriority: { low: 0, normal: 0, high: 0 } }
  for (const task of listTasks(userId)) {
    await sleep(REPORT_MS_PER_TASK)
    report.total += 1
    report[task.status] += 1
    report.byPriority[task.priority] += 1
  }
  return report
}

// ---------- unreliable upstream ----------

const ESTIMATOR_FAILURE_RATE = 0.2

/** Stands in for a third-party service that drops about one request in five. */
export function estimateEffort(userId: number, id: number): { ok: true; minutes: number } | { ok: false; error: string } {
  const task = getTask(userId, id)
  if (!task) return { ok: false, error: 'Task not found' }
  if (Math.random() < ESTIMATOR_FAILURE_RATE) {
    return { ok: false, error: 'Estimator unavailable, try again' }
  }
  const weight = { low: 1, normal: 2, high: 3 }[task.priority]
  return { ok: true, minutes: 15 * weight + task.title.length }
}

// ---------- background jobs ----------

const EXPORT_JOB_MS = 600

interface ExportRow {
  id: number
  status: 'queued' | 'done'
  task_count: number | null
  created_at: number
}

const toExport = (r: ExportRow): ExportJob => ({
  id: r.id,
  status: r.status,
  taskCount: r.task_count,
  createdAt: r.created_at,
})

/** Inserts a queued job and returns at once; the work finishes after the response. */
export function startExport(userId: number): ExportJob {
  const info = db()
    .prepare("INSERT INTO exports (user_id, status, created_at) VALUES (?, 'queued', ?)")
    .run(userId, Date.now())
  const id = Number(info.lastInsertRowid)
  setTimeout(() => {
    const count = (db().prepare('SELECT COUNT(*) AS n FROM tasks WHERE user_id = ?').get(userId) as { n: number }).n
    db().prepare("UPDATE exports SET status = 'done', task_count = ? WHERE id = ?").run(count, id)
    logActivity(userId, `Export #${id} finished`)
  }, EXPORT_JOB_MS)
  return toExport(db().prepare('SELECT * FROM exports WHERE id = ?').get(id) as unknown as ExportRow)
}

export function listExports(userId: number): ExportJob[] {
  const rows = db()
    .prepare('SELECT * FROM exports WHERE user_id = ? ORDER BY id DESC LIMIT 20')
    .all(userId) as unknown as ExportRow[]
  return rows.map(toExport)
}
