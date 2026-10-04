import { createFileRoute, notFound, useRouter } from '@tanstack/react-router'
import { TaskForm } from '../../components/TaskForm'
import { getTaskFn, updateTaskFn } from '../../lib/fns'

export const Route = createFileRoute('/_authed/tasks/$taskId/edit')({
  loader: async ({ params }) => {
    const task = await getTaskFn({ data: { id: Number(params.taskId) } })
    if (!task) throw notFound()
    return task
  },
  component: EditTask,
  notFoundComponent: () => <h1>Task not found</h1>,
})

function EditTask() {
  const task = Route.useLoaderData()
  const router = useRouter()
  return (
    <>
      <h1>Edit task</h1>
      <TaskForm
        initial={task}
        submitLabel="Save changes"
        onSubmit={(values) => updateTaskFn({ data: { id: task.id, ...values } })}
        onSaved={async (saved) => {
          await router.invalidate()
          await router.navigate({ to: '/tasks/$taskId', params: { taskId: String(saved.id) } })
        }}
      />
    </>
  )
}
