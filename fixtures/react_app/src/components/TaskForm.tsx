import { useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { PRIORITIES, type FieldErrors, type Result, type Task } from '../lib/types'

interface Values {
  title: string
  priority: string
  notes: string
}

export function TaskForm(props: {
  initial?: Task
  submitLabel: string
  onSubmit: (values: Values) => Promise<Result<{ task: Task }>>
  onSaved: (task: Task) => Promise<void> | void
}) {
  const [errors, setErrors] = useState<FieldErrors>({})
  const [pending, setPending] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    const result = await props.onSubmit({
      title: String(form.get('title')),
      priority: String(form.get('priority')),
      notes: String(form.get('notes')),
    })
    setPending(false)
    if (!result.ok) return setErrors(result.errors)
    await props.onSaved(result.task)
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      {errors.form && (
        <p className="error" role="alert">
          {errors.form}
        </p>
      )}
      <label>
        Title
        <input name="title" defaultValue={props.initial?.title ?? ''} />
        {errors.title && <span className="error">{errors.title}</span>}
      </label>
      <label>
        Priority
        <select name="priority" defaultValue={props.initial?.priority ?? 'normal'}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        {errors.priority && <span className="error">{errors.priority}</span>}
      </label>
      <label>
        Notes
        <textarea name="notes" rows={3} defaultValue={props.initial?.notes ?? ''} />
        {errors.notes && <span className="error">{errors.notes}</span>}
      </label>
      <div className="toolbar">
        <button type="submit" disabled={pending}>
          {props.submitLabel}
        </button>
        <Link to="/tasks">Cancel</Link>
      </div>
    </form>
  )
}
