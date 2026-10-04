import { createServerFn } from '@tanstack/react-start'
import { currentUser, endSession, requireUser, startSession } from '../server/session'
import * as store from '../server/store'
import type { StatusFilter } from './types'

// ---------- auth ----------

export const getMe = createServerFn({ method: 'GET' }).handler(() => currentUser())

export const signupFn = createServerFn({ method: 'POST' })
  .validator((data: store.SignupInput) => data)
  .handler(({ data }) => {
    const result = store.signup(data)
    if (!result.ok) return result
    startSession(result.user.id)
    return { ok: true as const }
  })

export const loginFn = createServerFn({ method: 'POST' })
  .validator((data: { email: string; password: string }) => data)
  .handler(({ data }) => {
    const result = store.authenticate(data.email, data.password)
    if (!result.ok) return result
    startSession(result.user.id)
    return { ok: true as const }
  })

export const logoutFn = createServerFn({ method: 'POST' }).handler(() => {
  endSession()
  return { ok: true as const }
})

export const updateNameFn = createServerFn({ method: 'POST' })
  .validator((data: { name: string }) => data)
  .handler(({ data }) => store.updateName(requireUser().id, data.name))

// ---------- tasks ----------

export const listTasksFn = createServerFn({ method: 'GET' })
  .validator((data: { q?: string; status?: StatusFilter }) => data)
  .handler(({ data }) => store.listTasks(requireUser().id, data.q, data.status))

export const getTaskFn = createServerFn({ method: 'GET' })
  .validator((data: { id: number }) => data)
  .handler(({ data }) => store.getTask(requireUser().id, data.id))

export const createTaskFn = createServerFn({ method: 'POST' })
  .validator((data: store.TaskInput) => data)
  .handler(({ data }) => store.createTask(requireUser().id, data))

export const updateTaskFn = createServerFn({ method: 'POST' })
  .validator((data: store.TaskInput & { id: number }) => data)
  .handler(({ data }) => store.updateTask(requireUser().id, data.id, data))

export const toggleTaskFn = createServerFn({ method: 'POST' })
  .validator((data: { id: number }) => data)
  .handler(({ data }) => store.toggleTask(requireUser().id, data.id))

export const deleteTaskFn = createServerFn({ method: 'POST' })
  .validator((data: { id: number }) => data)
  .handler(({ data }) => store.deleteTask(requireUser().id, data.id))

export const estimateEffortFn = createServerFn({ method: 'POST' })
  .validator((data: { id: number }) => data)
  .handler(({ data }) => store.estimateEffort(requireUser().id, data.id))

// ---------- activity, exports, reports, import ----------

export const listActivityFn = createServerFn({ method: 'GET' }).handler(() => store.listActivity(requireUser().id))

export const listExportsFn = createServerFn({ method: 'GET' }).handler(() => store.listExports(requireUser().id))

export const startExportFn = createServerFn({ method: 'POST' }).handler(() => store.startExport(requireUser().id))

export const buildReportFn = createServerFn({ method: 'POST' }).handler(() => store.buildReport(requireUser().id))

export const importTasksFn = createServerFn({ method: 'POST' })
  .validator((data: { text: string }) => data)
  .handler(({ data }) => store.importTasks(requireUser().id, data.text))
