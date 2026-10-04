import { createFileRoute } from '@tanstack/react-router'
import { startSession } from '../../server/session'
import { signup } from '../../server/store'

export const Route = createFileRoute('/api/signup')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const result = signup(await request.json())
        if (!result.ok) return Response.json(result, { status: 422 })
        startSession(result.user.id)
        return Response.json({ ok: true, user: result.user }, { status: 201 })
      },
    },
  },
})
