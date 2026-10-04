import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { listExportsFn, startExportFn } from '../../lib/fns'

const POLL_MS = 300

export const Route = createFileRoute('/_authed/exports')({
  loader: () => listExportsFn(),
  component: Exports,
})

function Exports() {
  const initial = Route.useLoaderData()
  const [jobs, setJobs] = useState(initial)
  const waiting = jobs.some((job) => job.status === 'queued')

  // Poll only while a job is still in the queue.
  useEffect(() => {
    if (!waiting) return
    let stopped = false
    const timer = setInterval(async () => {
      const next = await listExportsFn()
      if (!stopped) setJobs(next)
    }, POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [waiting])

  async function start() {
    const job = await startExportFn()
    setJobs((current) => [job, ...current])
  }

  return (
    <>
      <h1>Exports</h1>
      <button type="button" onClick={start}>
        Start export
      </button>
      {jobs.length === 0 ? (
        <p>No exports yet.</p>
      ) : (
        <ul className="plain" aria-label="Exports">
          {jobs.map((job) => (
            <li key={job.id} data-status={job.status}>
              Export #{job.id}:{' '}
              {job.status === 'queued' ? 'queued' : `done, ${job.taskCount} ${job.taskCount === 1 ? 'task' : 'tasks'}`}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
