export type Priority = 'low' | 'normal' | 'high'
export type TaskStatus = 'open' | 'done'
export type StatusFilter = 'all' | TaskStatus

export interface User {
  id: number
  email: string
  name: string
}

export interface Task {
  id: number
  title: string
  priority: Priority
  status: TaskStatus
  notes: string
  createdAt: number
}

export interface ActivityEntry {
  id: number
  message: string
  createdAt: number
}

export interface ExportJob {
  id: number
  status: 'queued' | 'done'
  taskCount: number | null
  createdAt: number
}

export interface Report {
  total: number
  open: number
  done: number
  byPriority: Record<Priority, number>
}

export type FieldErrors = Record<string, string>
export type Result<T = {}> = ({ ok: true } & T) | { ok: false; errors: FieldErrors }

export const PRIORITIES: Priority[] = ['low', 'normal', 'high']
