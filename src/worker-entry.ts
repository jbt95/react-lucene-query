import { serveQueryWorker } from './worker'

// The bundled entry receives a strictly decoded path-only schema before processing queries.
serveQueryWorker(undefined, self)
