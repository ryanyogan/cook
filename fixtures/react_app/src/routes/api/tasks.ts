import { createFileRoute } from '@tanstack/react-router'
import { currentUser } from '../../server/session'
import { createTask, listTasks } from '../../server/store'

const unauthorized = () => Response.json({ ok: false, error: 'Not signed in' }, { status: 401 })

export const Route = createFileRoute('/api/tasks')({
  server: {
    handlers: {
      GET: async () => {
        const user = currentUser()
        if (!user) return unauthorized()
        return Response.json({ tasks: listTasks(user.id) })
      },
      POST: async ({ request }) => {
        const user = currentUser()
        if (!user) return unauthorized()
        const result = createTask(user.id, await request.json())
        return Response.json(result, { status: result.ok ? 201 : 422 })
      },
    },
  },
})
