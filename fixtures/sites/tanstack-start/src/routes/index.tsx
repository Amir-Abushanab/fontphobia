import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <>
      <h1>TanStack Start fixture</h1>
      <p>Body text in Inter, with <em>italics</em>, <strong>bold</strong>, café and Țară.</p>
      <p><code>const x = 42;</code></p>
    </>
  )
}
