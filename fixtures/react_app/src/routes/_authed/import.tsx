import { useState, type FormEvent } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { importTasksFn } from '../../lib/fns'

export const Route = createFileRoute('/_authed/import')({ component: Import })

function Import() {
  const [result, setResult] = useState<{ imported: number; skipped: string[] } | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = String(new FormData(event.currentTarget).get('lines'))
    setPending(true)
    setResult(null)
    setResult(await importTasksFn({ data: { text } }))
    setPending(false)
  }

  return (
    <>
      <h1>Import tasks</h1>
      <p>One task per line. Add a priority after a bar, for example: Call the plumber | high</p>
      <form className="stack" onSubmit={onSubmit}>
        <label>
          Tasks to import
          <textarea name="lines" rows={8} />
        </label>
        <button type="submit" disabled={pending}>
          Import
        </button>
      </form>
      {pending && <p role="status">Importing…</p>}
      {result && (
        <div className="notice" data-testid="import-result">
          <p>
            Imported {result.imported} {result.imported === 1 ? 'task' : 'tasks'}
          </p>
          {result.skipped.length > 0 && (
            <>
              <p>Skipped {result.skipped.length}:</p>
              <ul aria-label="Skipped lines">
                {result.skipped.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </>
          )}
          <Link to="/tasks">View tasks</Link>
        </div>
      )}
    </>
  )
}
