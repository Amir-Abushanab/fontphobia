import { Effect } from 'effect'
import { Server } from 'foldkit/experimental'

import { init, view } from './main'

const head = [
  '<link rel="preconnect" href="https://fonts.googleapis.com">',
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  '<link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&display=swap" rel="stylesheet">',
].join('')

export const renderDocument: Server.DocumentRenderer = (application, assets) =>
  Server.renderDocument(application, assets, { head })

export const prerenderPaths: ReadonlyArray<string> = [
  '/',
  '/about',
  '/posts/1',
  '/posts/2',
]

export const renderPage = (request: Request): Promise<Server.EntryResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const renderedApplication = yield* Server.renderToString(
        { routing: {}, init, view },
        { url: request.url },
      )

      return Server.Rendered(renderedApplication)
    }),
  )
