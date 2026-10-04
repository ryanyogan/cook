import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const { user } = Route.useRouteContext()
  return (
    <>
      <h1>Keep track of what needs doing</h1>
      {user ? (
        <p>
          Welcome back, {user.name}. <Link to="/tasks">Go to your tasks</Link>
        </p>
      ) : (
        <p>
          <Link to="/signup">Create an account</Link> or <Link to="/login">log in to continue</Link>.
        </p>
      )}
    </>
  )
}
