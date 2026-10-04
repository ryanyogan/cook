import { createFileRoute } from '@tanstack/react-router'
import { startSession } from '../../server/session'
import { authenticate } from '../../server/store'

export const Route = createFileRoute('/api/login')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.json()
        const result = authenticate(body.email, body.password)
        if (!result.ok) return Response.json(result, { status: 401 })
        startSession(result.user.id)
        return Response.json({ ok: true, user: result.user })
      },
    },
  },
})
