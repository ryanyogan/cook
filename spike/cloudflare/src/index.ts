// Worker in front of the container. Throwaway spike code.
// Every endpoint needs the header `x-spike-secret` (Wrangler secret SPIKE_SECRET).
// `?instance=<name>` picks the container instance (default "a").
//   GET  /state    container state, does not wake it
//   POST /wake     start the instance and wait for the control server's port
//   POST /stop     SIGTERM the instance (it sleeps)
//   POST /destroy  SIGKILL the instance
//   anything else  forwarded to the control server in the container (wakes it): /ping /info /mark /prepare /run
import { Container, getContainer } from '@cloudflare/containers'

interface Env {
  RUNNER: DurableObjectNamespace<Runner>
  SPIKE_SECRET?: string
}

export class Runner extends Container<Env> {
  defaultPort = 8080
  sleepAfter = '90s'
}

function same(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  if (ea.length !== eb.length) return false
  let diff = 0
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i]
  return diff === 0
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const given = request.headers.get('x-spike-secret') ?? ''
    if (!env.SPIKE_SECRET || env.SPIKE_SECRET.length < 32 || !same(given, env.SPIKE_SECRET)) {
      return new Response('unauthorized\n', { status: 401 })
    }
    const url = new URL(request.url)
    const name = url.searchParams.get('instance') ?? 'a'
    const stub = getContainer(env.RUNNER, name)
    const t0 = Date.now()
    try {
      if (url.pathname === '/state') return Response.json({ instance: name, state: await stub.getState() })
      if (url.pathname === '/wake') {
        await stub.startAndWaitForPorts()
        return Response.json({ instance: name, wakeMs: Date.now() - t0, state: await stub.getState() })
      }
      if (url.pathname === '/stop') {
        await stub.stop()
        return Response.json({ instance: name, stopped: true, ms: Date.now() - t0 })
      }
      if (url.pathname === '/destroy') {
        await stub.destroy()
        return Response.json({ instance: name, destroyed: true, ms: Date.now() - t0 })
      }
      const res = await stub.fetch(request)
      const out = new Response(res.body, res)
      out.headers.set('x-worker-ms', String(Date.now() - t0))
      return out
    } catch (e) {
      return Response.json({ instance: name, error: String(e), ms: Date.now() - t0 }, { status: 502 })
    }
  },
}
