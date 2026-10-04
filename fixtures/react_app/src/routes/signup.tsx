import { useState, type FormEvent } from 'react'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { signupFn } from '../lib/fns'
import type { FieldErrors } from '../lib/types'

export const Route = createFileRoute('/signup')({
  beforeLoad: ({ context }) => {
    if (context.user) throw redirect({ to: '/tasks' })
  },
  component: Signup,
})

function Signup() {
  const router = useRouter()
  const [errors, setErrors] = useState<FieldErrors>({})
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    const result = await signupFn({
      data: {
        name: String(form.get('name')),
        email: String(form.get('email')),
        password: String(form.get('password')),
      },
    })
    setPending(false)
    if (!result.ok) return setErrors(result.errors)
    await router.invalidate()
    await router.navigate({ to: '/tasks' })
  }

  return (
    <>
      <h1>Create your account</h1>
      <form className="stack" onSubmit={onSubmit} noValidate>
        <label>
          Name
          <input name="name" autoComplete="name" />
          {errors.name && <span className="error">{errors.name}</span>}
        </label>
        <label>
          Email
          <input name="email" type="email" autoComplete="email" />
          {errors.email && <span className="error">{errors.email}</span>}
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="new-password" />
          {errors.password && <span className="error">{errors.password}</span>}
        </label>
        <button type="submit" disabled={pending}>
          Sign up
        </button>
      </form>
    </>
  )
}
