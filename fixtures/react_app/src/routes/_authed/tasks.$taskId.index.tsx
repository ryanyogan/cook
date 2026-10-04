import { useState } from 'react'
import { createFileRoute, Link, notFound, useRouter } from '@tanstack/react-router'
import { deleteTaskFn, estimateEffortFn, getTaskFn } from '../../lib/fns'

export const Route = createFileRoute('/_authed/tasks/$taskId/')({
  loader: async ({ params }) => {
    const task = await getTaskFn({ data: { id: Number(params.taskId) } })
    if (!task) throw notFound()
    return task
  },
  component: TaskDetail,
  notFoundComponent: () => <h1>Task not found</h1>,
})

function TaskDetail() {
  const task = Route.useLoaderData()
  const router = useRouter()
  const [estimate, setEstimate] = useState<{ minutes?: number; error?: string }>({})
  const [confirming, setConfirming] = useState(false)

  async function estimateEffort() {
    const result = await estimateEffortFn({ data: { id: task.id } })
    setEstimate(result.ok ? { minutes: result.minutes } : { error: result.error })
  }

  async function remove() {
    await deleteTaskFn({ data: { id: task.id } })
    await router.invalidate()
    await router.navigate({ to: '/tasks' })
  }

  return (
    <>
      <h1>{task.title}</h1>
      <dl>
        <dt>Priority</dt>
        <dd data-testid="priority">{task.priority}</dd>
        <dt>Status</dt>
        <dd data-testid="status">{task.status}</dd>
        <dt>Notes</dt>
        <dd data-testid="notes">{task.notes || 'No notes'}</dd>
      </dl>

      <div className="toolbar">
        <Link to="/tasks/$taskId/edit" params={{ taskId: String(task.id) }}>
          Edit task
        </Link>
        <button type="button" onClick={estimateEffort}>
          Estimate effort
        </button>
        {confirming ? (
          <>
            <span>Delete this task?</span>
            <button type="button" onClick={remove}>
              Confirm delete
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirming(true)}>
            Delete task
          </button>
        )}
      </div>

      {estimate.minutes !== undefined && (
        <p className="notice fade-in" data-testid="estimate">
          Estimated effort: {estimate.minutes} minutes
        </p>
      )}
      {estimate.error && (
        <p className="error" role="alert">
          {estimate.error}
        </p>
      )}
      <Link to="/tasks">Back to tasks</Link>
    </>
  )
}
