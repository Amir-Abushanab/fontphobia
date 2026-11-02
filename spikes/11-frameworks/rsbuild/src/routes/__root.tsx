import { Link, Outlet, createRootRoute } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: () => (
    <>
      <nav>
        <Link to="/">Home</Link> <Link to="/about">About</Link>{' '}
        <Link to="/posts/$id" params={{ id: 'one' }}>Post one</Link>{' '}
        <Link to="/posts/$id" params={{ id: 'two' }}>Post two</Link>
      </nav>
      <Outlet />
    </>
  ),
})
