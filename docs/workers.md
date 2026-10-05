# Off-main-thread filtering

[← README](../README.md#appendix) · [Quick start](../README.md#quick-start)

Filtering a large record set on the keystroke blocks the input thread. The `/worker` entry moves parsing, suggestion, clause listing, and filtering to a worker.

The default client loads a bundled, self-contained worker and initializes it with your path-only fields and unknown-field policy before the first query.

```ts
// main thread
import { createQueryWorkerSearch } from 'react-lucene-query/worker'

const search = createQueryWorkerSearch({ fields })
const rows = await search.filter('status:ready', records)
```

For a custom analyzer or a bundler-specific worker entry, configure a module explicitly:

```ts
// query.worker.ts
import { createWorkerEngine, serveQueryWorker } from 'react-lucene-query/worker'

const engine = createWorkerEngine({ fields }) // fields use `path`, never `read`
serveQueryWorker(engine, self)

// main thread
const search = createQueryWorkerSearch({
  fields,
  worker: new Worker(new URL('./query.worker.ts', import.meta.url), { type: 'module' }),
})
```

Worker engines refuse a `read` accessor and name the offending field. The default client also rejects `analyze` callbacks, which cannot be cloned; custom modules can define them locally. An explicit `worker` or `workerUrl` owns its configuration. Every call is correlated by id, so out-of-order answers resolve the correct promise. Worker load/deserialization errors reject outstanding and future calls rather than hanging. Filtering needs a complete query: an invalid one fails the request instead of answering with an empty result the caller would report as "nothing matched". `handleRequest` is exported so the protocol can be tested, or driven, without a `Worker`.

Worker messages are untrusted input and are decoded before the engine sees them. Requests and responses are Effect Schemas and the exported `WorkerRequest` / `WorkerResponse` types are derived from them, which means a field added to one side cannot be forgotten by the other.

- Decoding is strict: a missing required field, a mistyped `caret`, an unexpected key, or two payloads in one message is refused rather than matching a neighbouring shape.
- A success response echoes the call `type` it answers, so a client can never read `matches` off a `parse` answer.
- A refused message is answered with a failure response carrying the id it had, or `-1` when no id could be read. An unreadable answer is fatal to every outstanding request rather than left to wait forever.
- `isWorkerRequest` decodes untrusted messages; `handleRequest` accepts decoded query calls. `serveQueryWorker` handles the initialization handshake.

Related: [Path accessors](fields.md) · [Engine performance](engine.md#performance-and-composition-notes)
