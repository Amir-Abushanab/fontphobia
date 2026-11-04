import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import '@fontsource-variable/inter'
import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: 'TanStack Start fixture' }],
    links: [
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&display=swap' },
      { rel: 'stylesheet', href: appCss },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body style={{ fontFamily: "'Inter Variable', sans-serif" }}>
        <nav>
          <a href="/">Home</a> · <a href="/about">About</a> · <a href="/posts/1">Post 1</a> · <a href="/posts/2">Post 2</a>
        </nav>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
