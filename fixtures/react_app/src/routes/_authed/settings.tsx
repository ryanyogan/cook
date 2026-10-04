import { useState, type FormEvent } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { updateNameFn } from '../../lib/fns'

export const Route = createFileRoute('/_authed/settings')({ component: Settings })

function Settings() {
  const { user } = Route.useRouteContext()
  const router = useRouter()
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = String(new FormData(event.currentTarget).get('name'))
    setSaved(false)
    const result = await updateNameFn({ data: { name } })
    if (!result.ok) return setError(result.errors.name)
    setError('')
    await router.invalidate()
    setSaved(true)
  }

  return (
    <>
      <h1>Settings</h1>
      <p>Account email: {user.email}</p>
      <form className="stack" onSubmit={onSubmit} noValidate>
        <label>
          Display name
          <input name="name" defaultValue={user.name} />
          {error && <span className="error">{error}</span>}
        </label>
        <button type="submit">Save settings</button>
      </form>
      {saved && (
        <p className="notice" role="status">
          Settings saved
        </p>
      )}
    </>
  )
}
