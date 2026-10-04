/// <reference types="vite/client" />
import { useEffect, type ReactNode } from 'react'
import { createRootRoute, HeadContent, Link, Outlet, Scripts, useRouter } from '@tanstack/react-router'
import { getMe, logoutFn } from '../lib/fns'
import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Taskboard' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  beforeLoad: async () => ({ user: await getMe() }),
  component: RootComponent,
  shellComponent: RootDocument,
  notFoundComponent: () => (
    <main>
      <h1>Page not found</h1>
      <Link to="/">Back home</Link>
    </main>
  ),
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

function RootComponent() {
  const { user } = Route.useRouteContext()
  const router = useRouter()

  // Event handlers only exist after hydration; this lets anything driving the
  // page (including a person with devtools open) see when that has happened.
  useEffect(() => {
    document.documentElement.dataset.hydrated = 'true'
  }, [])

  async function logout() {
    await logoutFn()
    await router.invalidate()
    await router.navigate({ to: '/' })
  }

  return (
    <>
      <header className="site">
        <Link to="/">
          <strong>Taskboard</strong>
        </Link>
        {user ? (
          <>
            <nav aria-label="Main">
              <Link to="/tasks" activeProps={{ className: 'active' }}>
                Tasks
              </Link>
              <Link to="/activity" activeProps={{ className: 'active' }}>
                Activity
              </Link>
              <Link to="/exports" activeProps={{ className: 'active' }}>
                Exports
              </Link>
              <Link to="/reports" activeProps={{ className: 'active' }}>
                Reports
              </Link>
              <Link to="/import" activeProps={{ className: 'active' }}>
                Import
              </Link>
              <Link to="/settings" activeProps={{ className: 'active' }}>
                Settings
              </Link>
            </nav>
            <span data-testid="current-user">Signed in as {user.name}</span>
            <button type="button" onClick={logout}>
              Log out
            </button>
          </>
        ) : (
          <nav aria-label="Main">
            <Link to="/login">Log in</Link>
            <Link to="/signup">Sign up</Link>
          </nav>
        )}
      </header>
      <main>
        <Outlet />
      </main>
    </>
  )
}
