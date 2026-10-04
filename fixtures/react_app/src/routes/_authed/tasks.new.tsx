import { createFileRoute, useRouter } from '@tanstack/react-router'
import { TaskForm } from '../../components/TaskForm'
import { createTaskFn } from '../../lib/fns'

export const Route = createFileRoute('/_authed/tasks/new')({ component: NewTask })

function NewTask() {
  const router = useRouter()
  return (
    <>
      <h1>New task</h1>
      <TaskForm
        submitLabel="Create task"
        onSubmit={(values) => createTaskFn({ data: values })}
        onSaved={async () => {
          await router.invalidate()
          await router.navigate({ to: '/tasks' })
        }}
      />
    </>
  )
}
