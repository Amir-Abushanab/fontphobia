import { Runtime } from 'foldkit'

import { Message, Model, init, update, view } from './main'
import '@fontsource-variable/inter'
import './styles.css'

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  container: document.getElementById('root'),
  routing: {
    onUrlRequest: request => Message.ClickedLink({ request }),
    onUrlChange: url => Message.ChangedUrl({ url }),
  },
  devTools: {
    Message,
  },
})

Runtime.hydrate(application)
