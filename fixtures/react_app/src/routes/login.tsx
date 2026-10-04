import { useState, type FormEvent } from 'react'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { loginFn } from '../lib/fns'

export const Route = createFileRoute('/login')({
  beforeLoad: ({ context }) => {
    if (context.user) throw redirect({ to: '/tasks' })
  },
  component: Login,
})

function Login() {
  const router = useRouter()
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    const result = await loginFn({
      data: { email: String(form.get('email')), password: String(form.get('password')) },
    })
    setPending(false)
    if (!result.ok) return setError(result.errors.form)
    await router.invalidate()
    await router.navigate({ to: '/tasks' })
  }

  return (
    <>
      <h1>Log in</h1>
      <form className="stack" onSubmit={onSubmit} noValidate>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <label>
          Email
          <input name="email" type="email" autoComplete="email" />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" />
        </label>
        <button type="submit" disabled={pending}>
          Log in
        </button>
      </form>
    </>
  )
}
