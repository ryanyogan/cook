import { useState, type FormEvent } from 'react'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { listTasksFn, toggleTaskFn } from '../../lib/fns'
import type { StatusFilter, TaskStatus } from '../../lib/types'

const FILTERS: StatusFilter[] = ['all', 'open', 'done']

export const Route = createFileRoute('/_authed/tasks/')({
  validateSearch: (search: Record<string, unknown>): { q?: string; status?: StatusFilter } => ({
    q: typeof search.q === 'string' && search.q ? search.q : undefined,
    status: search.status === 'open' || search.status === 'done' ? search.status : undefined,
  }),
  loaderDeps: ({ search }) => ({ q: search.q, status: search.status }),
  loader: ({ deps }) => listTasksFn({ data: deps }),
  component: TaskList,
})

function TaskList() {
  const tasks = Route.useLoaderData()
  const { q = '', status = 'all' } = Route.useSearch()
  const navigate = Route.useNavigate()
  const router = useRouter()

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = String(new FormData(event.currentTarget).get('q')).trim()
    navigate({ search: (prev) => ({ ...prev, q: value || undefined }) })
  }

  // Ticks show at once; the server catches up and the loader data replaces them.
  const [optimistic, setOptimistic] = useState<Record<number, TaskStatus>>({})

  async function toggle(id: number, next: TaskStatus) {
    setOptimistic((current) => ({ ...current, [id]: next }))
    try {
      await toggleTaskFn({ data: { id } })
      await router.invalidate()
    } finally {
      setOptimistic(({ [id]: _settled, ...rest }) => rest)
    }
  }

  return (
    <>
      <h1>Tasks</h1>
      <div className="toolbar">
        <form role="search" onSubmit={search} className="toolbar" style={{ margin: 0 }}>
          <label>
            Search tasks
            <input name="q" type="search" defaultValue={q} key={q} />
          </label>
          <button type="submit">Search</button>
        </form>
        <label>
          Show
          <select
            value={status}
            onChange={(e) => {
              const next = e.target.value as StatusFilter
              navigate({ search: (prev) => ({ ...prev, status: next === 'all' ? undefined : next }) })
            }}
          >
            {FILTERS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <Link to="/tasks/new">New task</Link>
      </div>

      <p data-testid="task-count">
        {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
      </p>

      {tasks.length === 0 ? (
        <p>{q || status !== 'all' ? 'No tasks match your filters.' : 'No tasks yet. Create your first one.'}</p>
      ) : (
        <ul className="tasks" aria-label="Tasks">
          {tasks.map((task) => {
            const done = (optimistic[task.id] ?? task.status) === 'done'
            return (
            <li key={task.id} className={done ? 'done' : undefined}>
              <input
                type="checkbox"
                aria-label={`Mark "${task.title}" done`}
                checked={done}
                disabled={task.id in optimistic}
                onChange={() => toggle(task.id, done ? 'open' : 'done')}
              />
              <Link to="/tasks/$taskId" params={{ taskId: String(task.id) }}>
                {task.title}
              </Link>
              <span className={`badge ${task.priority}`}>{task.priority}</span>
            </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
