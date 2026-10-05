import assert from 'node:assert/strict'
import { Data, Effect, Result, Schema } from 'effect'
import { InvalidQueryError, QueryEngine, type SearchAdapter } from '../src/core'
import { fields, records, type Shipment } from '../tests/fixtures'

// This request and response format belongs to this application, not the library.
const SearchRequest = Schema.Struct({ query: Schema.String })

const SearchResponse = Schema.Struct({
  records: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      carrier: Schema.String,
      status: Schema.String,
      units: Schema.Finite,
      due: Schema.String,
      active: Schema.Boolean,
      tags: Schema.Array(Schema.String),
      eta: Schema.String,
    }),
  ),
})

// The rejection shape is the library's own error, encoded — not a second copy of its fields.
const encodeRejection = Schema.encodeSync(InvalidQueryError)

class SearchTransportError extends Data.TaggedError('SearchTransportError')<{
  readonly cause: unknown
}> {}

class SearchHttpError extends Data.TaggedError('SearchHttpError')<{
  readonly status: number
}> {}

class SearchResponseError extends Data.TaggedError('SearchResponseError')<{
  readonly message: string
  readonly cause: unknown
}> {}

class InvalidSearchRequest extends Data.TaggedError('InvalidSearchRequest')<{
  readonly cause: unknown
}> {}

type SearchError = InvalidQueryError | SearchTransportError | SearchHttpError | SearchResponseError

// Configuration is fixed and checked by `example:backend`; a failure here is a broken build, not
// a runtime condition, so `orDie` surfaces the domain error instead of a FiberFailure.
const clientEngine = Effect.runSync(Effect.orDie(QueryEngine.make({ fields })))

const serverEngine = Effect.runSync(Effect.orDie(QueryEngine.make({ fields })))

let requests = 0

let executions = 0

// Only bind to loopback. Port zero avoids a fixed-port dependency.
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname !== '/search') {
      return new Response('Not found', { status: 404 })
    }

    if (request.method !== 'POST') {
      return new Response('Use POST', { status: 405, headers: { Allow: 'POST' } })
    }

    requests += 1

    return Effect.runPromise(
      Effect.gen(function* () {
        const input = yield* Effect.result(
          Effect.tryPromise({
            try: () => request.json(),
            catch: (cause) => new InvalidSearchRequest({ cause }),
          }).pipe(
            Effect.flatMap((payload) =>
              Schema.decodeUnknownEffect(SearchRequest)(payload).pipe(
                Effect.mapError((cause) => new InvalidSearchRequest({ cause })),
              ),
            ),
          ),
        )

        if (Result.isFailure(input)) {
          return Response.json({ message: 'Expected query text' }, { status: 400 })
        }

        // Never trust client validation or a client-supplied AST.
        const compiled = yield* Effect.result(serverEngine.compile(input.success.query))

        if (Result.isFailure(compiled)) {
          return Response.json(encodeRejection(compiled.failure), { status: 422 })
        }

        // A real repository call would start here, after server-side validation.
        executions += 1

        return Response.json({ records: records.filter(compiled.success.test) })
      }),
    )
  },
})

const endpoint = new URL('/search', server.url)

const requestSearch = (query: string): Effect.Effect<readonly Shipment[], SearchError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
          signal,
        }),
      catch: (cause) => new SearchTransportError({ cause }),
    })

    if (!response.ok && response.status !== 422) {
      return yield* Effect.fail(new SearchHttpError({ status: response.status }))
    }

    const payload: unknown = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) =>
        new SearchResponseError({ message: 'Response is not readable JSON', cause }),
    })

    if (response.status === 422) {
      // Decoding the library's error Schema yields the error itself, so the client cannot
      // reconstruct a different shape than the server sent.
      const rejection = yield* Schema.decodeUnknownEffect(InvalidQueryError)(payload).pipe(
        Effect.mapError(
          (cause) =>
            new SearchResponseError({ message: 'Invalid query rejection response', cause }),
        ),
      )

      return yield* Effect.fail(rejection)
    }

    const decoded = yield* Schema.decodeUnknownEffect(SearchResponse)(payload).pipe(
      Effect.mapError(
        (cause) => new SearchResponseError({ message: 'Invalid search response', cause }),
      ),
    )

    return decoded.records
  })

// Send source text, not the AST. The server validates it with its own schema.
const searchShipments: SearchAdapter<readonly Shipment[], SearchError> = (parsed) =>
  requestSearch(parsed.text)

const query = 'status:ready AND units:[100 TO 200] AND due:[2026-10-24 TO 2026-10-25]'

try {
  const found = await Effect.runPromise(clientEngine.search(query, searchShipments))
  assert.deepEqual(
    found.map((record) => record.id),
    ['SHP-1042'],
  )
  console.log(
    'Filtered shipments:',
    found.map((record) => record.id),
  )

  const previousRequests = requests
  const previousExecutions = executions

  const invalid = await Effect.runPromise(
    Effect.result(clientEngine.search('units:[100 TO]', searchShipments)),
  )

  assert(Result.isFailure(invalid), 'Invalid input must fail')
  assert(invalid.failure instanceof InvalidQueryError)
  assert.equal(requests, previousRequests, 'Client validation must prevent the HTTP request')
  assert.equal(executions, previousExecutions)
  console.log('Client rejected invalid query:', invalid.failure._tag)

  // Bypass the client engine to show that server validation is also required.
  const rejected = await Effect.runPromise(Effect.result(requestSearch('units:[100 TO]')))
  assert(Result.isFailure(rejected), 'The server must reject invalid input')
  assert(rejected.failure instanceof InvalidQueryError)
  assert.equal(requests, previousRequests + 1)
  assert.equal(executions, previousExecutions, 'Invalid input must not reach backend execution')
  console.log('Server rejected invalid query:', rejected.failure._tag)
} finally {
  await server.stop(true)
}

// The awaited stop closes all connections before the next real HTTP request.
const offline = await Effect.runPromise(Effect.result(clientEngine.search(query, searchShipments)))

assert(Result.isFailure(offline), 'A stopped server must produce a transport failure')

assert(offline.failure instanceof SearchTransportError)

console.log('Handled transport failure:', offline.failure._tag)
