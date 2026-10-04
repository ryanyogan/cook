import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { listActivityFn } from '../../lib/fns'

const POLL_MS = 500

export const Route = createFileRoute('/_authed/activity')({
  loader: () => listActivityFn(),
  component: Activity,
})

function Activity() {
  const initial = Route.useLoaderData()
  const [entries, setEntries] = useState(initial)

  useEffect(() => {
    let stopped = false
    const timer = setInterval(async () => {
      try {
        const next = await listActivityFn()
        if (!stopped) setEntries(next)
      } catch {
        // A failed poll is retried on the next tick.
      }
    }, POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [])

  return (
    <>
      <h1>Activity</h1>
      {entries.length === 0 ? (
        <p>Nothing has happened yet.</p>
      ) : (
        <ol className="plain" aria-label="Activity feed">
          {entries.map((entry) => (
            <li key={entry.id} className="fade-in">
              {entry.message}
            </li>
          ))}
        </ol>
      )}
    </>
  )
}
