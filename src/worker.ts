// Off-main-thread filtering. Schema accessors must be plain property paths, because a function
// cannot cross a structured clone; `createWorkerEngine` rejects a `read` field at construction.
import { Match, Option, Result, Schema } from 'effect'
import { QUERY_FIELD_TYPES, isPathField, type QueryField } from './core/fields'
import { createQueryEngine } from './engine-adapter'
import type { QueryEngine } from './engine-adapter'
import { hasErrors } from './core/parser'
import type { ParsedQuery, SuggestionList } from './core'
import type { Clause } from './core/clauses'
import type { QueryEngineOptions } from './core/engine'

/**
 * The protocol is the one place in this package where a value arrives from outside. The schemas
 * below are the contract, and the exported types are derived from them, so a field added to a
 * message cannot be forgotten by either side. Decoding is strict (`onExcessProperty: 'error'`):
 * an ambiguous or misspelled message is rejected instead of matching a neighbouring member.
 */
const PortableFields = Schema.Array(
  Schema.Struct({
    key: Schema.String,
    label: Schema.String,
    type: Schema.Literals(QUERY_FIELD_TYPES),
    path: Schema.String,
    options: Schema.optional(Schema.Array(Schema.String)),
    freeText: Schema.optional(Schema.Boolean),
  }),
)

const WorkerRequestSchema = Schema.Union([
  Schema.Struct({
    id: Schema.Int,
    type: Schema.Literal('initialize'),
    fields: PortableFields,
    unknownFields: Schema.optional(Schema.Literals(['ignore', 'suggest', 'error'])),
  }),
  Schema.Struct({ id: Schema.Int, type: Schema.Literal('parse'), text: Schema.String }),
  Schema.Struct({ id: Schema.Int, type: Schema.Literal('clauses'), text: Schema.String }),
  Schema.Struct({
    id: Schema.Int,
    type: Schema.Literal('suggest'),
    text: Schema.String,
    caret: Schema.Int,
    records: Schema.optional(Schema.Array(Schema.Unknown)),
  }),
  Schema.Struct({
    id: Schema.Int,
    type: Schema.Literal('filter'),
    text: Schema.String,
    records: Schema.Array(Schema.Unknown),
  }),
])

/** A success response echoes the call it answers, so a client can never read the wrong field. */
const WorkerResponseSchema = Schema.Union([
  Schema.Struct({ id: Schema.Int, ok: Schema.Literal(true), type: Schema.Literal('initialize') }),
  Schema.Struct({
    id: Schema.Int,
    ok: Schema.Literal(true),
    type: Schema.Literal('parse'),
    parsed: Schema.Unknown,
  }),
  Schema.Struct({
    id: Schema.Int,
    ok: Schema.Literal(true),
    type: Schema.Literal('clauses'),
    clauses: Schema.Unknown,
  }),
  Schema.Struct({
    id: Schema.Int,
    ok: Schema.Literal(true),
    type: Schema.Literal('suggest'),
    suggestions: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({
    id: Schema.Int,
    ok: Schema.Literal(true),
    type: Schema.Literal('filter'),
    matches: Schema.Array(Schema.Unknown),
  }),
  Schema.Struct({ id: Schema.Int, ok: Schema.Literal(false), error: Schema.String }),
])

export type WorkerRequest = typeof WorkerRequestSchema.Type

export type WorkerResponse = typeof WorkerResponseSchema.Type

/** The successful half of the protocol, discriminated by the call it answers. */
export type WorkerPayload = Extract<WorkerResponse, { readonly ok: true }>

type EngineRequest = Exclude<WorkerRequest, { readonly type: 'initialize' }>

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type WorkerCall = DistributiveOmit<WorkerRequest, 'id'>

/** An unattributable failure has no id to correlate, so it answers every outstanding request. */
const UNATTRIBUTABLE = -1

const decodeRequest = Schema.decodeUnknownOption(WorkerRequestSchema, { onExcessProperty: 'error' })

const decodeResponse = Schema.decodeUnknownOption(WorkerResponseSchema, {
  onExcessProperty: 'error',
})

const MessageId = Schema.Struct({ id: Schema.Int })

/** Every worker field must be cloneable, or the schema silently arrives empty at the other end. */
export function assertPortableFields<T>(fields: readonly QueryField<T>[]): void {
  const blocking = fields.flatMap((field) => (isPathField(field) ? [] : [field.key]))

  if (blocking.length > 0)
    throw new TypeError(`Worker fields need a path instead of read: ${blocking.join(', ')}`)
}

/**
 * Filtering needs a complete query, so a rejected one fails the request instead of answering with
 * an empty result the caller would report as "nothing matched".
 */
function filterValid<T>(engine: QueryEngine<T>, text: string, records: readonly T[]): readonly T[] {
  const parsed = engine.parse(text)

  if (hasErrors(parsed))
    throw new RangeError(parsed.diagnostics.map((entry) => entry.message).join('; '))

  return records.filter(engine.compile(text).test)
}

/** A message that is not a protocol call, paired with the id its failure must answer. */
export type WorkerRejection = {
  readonly id: number
  readonly error: string
}

/**
 * The decode seam: the one narrowing boundary in this file, and the only place an undecoded value
 * is accepted. Narrowing rather than returning a Result means everything downstream of it works
 * with `WorkerRequest`, so a malformed message cannot reach the engine as a half-shaped call.
 */
export function isWorkerRequest(message: unknown): message is WorkerRequest {
  return Option.isSome(decodeRequest(message))
}

/**
 * A message the protocol refused, as far as its correlation id goes. Only the id is read here, and
 * the Schema re-checks even that, so nothing about a malformed message is trusted.
 */
type RefusedMessage = { readonly id?: number }

/**
 * What to answer a message the schema refused. A caller is never left waiting: the id is the one the
 * message carried if one is readable, otherwise the unattributable id that fails every request.
 * Built where the message is still unparsed, because that is the only point its keys can be read
 * without pretending they are part of the protocol.
 */
function rejectWorkerMessage(message: RefusedMessage): WorkerRejection {
  return {
    id: Option.match(Schema.decodeUnknownOption(MessageId)(message), {
      onNone: () => UNATTRIBUTABLE,
      onSome: (carried) => carried.id,
    }),
    error: `Not a query worker message (keys: ${Object.keys(message).sort().join(', ')})`,
  }
}

/** Answers one decoded call. Each arm returns the payload its own type declares. */
function respond<T>(request: EngineRequest, engine: QueryEngine<T>): WorkerPayload {
  const match = Match.type<EngineRequest>().pipe(
    Match.discriminatorsExhaustive('type')({
      parse: (call) => ({
        id: call.id,
        ok: true as const,
        type: 'parse' as const,
        parsed: engine.parse(call.text),
      }),
      clauses: (call) => ({
        id: call.id,
        ok: true as const,
        type: 'clauses' as const,
        clauses: engine.clauses(call.text),
      }),
      suggest: (call) => ({
        id: call.id,
        ok: true as const,
        type: 'suggest' as const,
        // SAFETY: the request decoded strictly, so these are the caller's own records, and the
        // worker's schema is path-only, so each entry is the record the caller serialized.
        suggestions: engine.suggest(
          call.text,
          call.caret,
          call.records as readonly T[] | undefined,
        ),
      }),
      filter: (call) => ({
        id: call.id,
        ok: true as const,
        type: 'filter' as const,
        // SAFETY: see above; the payload is the caller's own records read by path.
        matches: filterValid(engine, call.text, call.records as readonly T[]),
      }),
    }),
  )

  return match(request)
}

/**
 * Answers one request in the worker. Exported so the protocol is testable without a `Worker`; the
 * decode happens in {@link isWorkerRequest}, so this only ever sees a well-shaped call.
 */
export function handleRequest<T>(request: EngineRequest, engine: QueryEngine<T>): WorkerResponse {
  return Result.match(
    Result.try(() => respond(request, engine)),
    {
      onSuccess: (response) => response,
      onFailure: (cause) => ({
        id: request.id,
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    },
  )
}

export interface WorkerScope {
  postMessage: (message: WorkerResponse) => void
  addEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void
}

/** Wires a scope to an engine, or waits for initialization when used by the bundled entry. */
export function serveQueryWorker<T>(engine: QueryEngine<T> | undefined, scope: WorkerScope): void {
  let configured = engine

  scope.addEventListener('message', (event) => {
    const message: unknown = event.data

    // A refused message is still answered, so a malformed caller never waits forever.
    if (!isWorkerRequest(message)) {
      const rejection = rejectWorkerMessage(Object(message))

      scope.postMessage({ id: rejection.id, ok: false, error: rejection.error })

      return
    }

    if (message.type === 'initialize') {
      const initialized = Result.try(() => createWorkerEngine<T>(message))

      scope.postMessage(
        Result.match(initialized, {
          onSuccess: (next) => {
            configured = next

            return { id: message.id, ok: true as const, type: 'initialize' as const }
          },
          onFailure: (cause) => ({
            id: message.id,
            ok: false as const,
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        }),
      )

      return
    }

    scope.postMessage(
      configured === undefined
        ? { id: message.id, ok: false, error: 'The query worker is not initialized' }
        : handleRequest(message, configured),
    )
  })
}

/** Builds the worker-side engine from portable fields, so both sides agree on one schema. */
export function createWorkerEngine<T>(options: QueryEngineOptions<T>): QueryEngine<T> {
  assertPortableFields(options.fields)

  return createQueryEngine(options)
}

export interface CreateQueryWorkerSearchOptions<T> extends QueryEngineOptions<T> {
  /** An existing worker. Pass one when the bundler cannot resolve the default module URL. */
  readonly worker?: Pick<
    Worker,
    'postMessage' | 'addEventListener' | 'removeEventListener' | 'terminate'
  >
  /** Module URL of the worker entry. Defaults to the sibling `worker-entry.js` of this module. */
  readonly workerUrl?: string | URL
}

export type WorkerSearch<T> = {
  readonly filter: (text: string, records: readonly T[]) => Promise<readonly T[]>
  readonly parse: (text: string) => Promise<ParsedQuery>
  readonly suggest: (
    text: string,
    caret: number,
    records?: readonly T[],
  ) => Promise<SuggestionList | undefined>
  readonly clauses: (text: string) => Promise<readonly Clause[]>
  readonly terminate: () => void
}

type Pending = {
  readonly resolve: (response: WorkerResponse) => void
  readonly reject: (reason: Error) => void
}

/**
 * Main-thread client for the worker entry. Every call is one request correlated by id, so a slow
 * filter can never resolve after a newer one and overwrite it.
 */
export function createQueryWorkerSearch<T>({
  worker,
  workerUrl,
  ...options
}: CreateQueryWorkerSearchOptions<T>): WorkerSearch<T> {
  assertPortableFields(options.fields)

  // Explicit worker modules own their schema; the bundled default receives the caller's schema.
  const bootstrap =
    worker === undefined && workerUrl === undefined
      ? {
          type: 'initialize' as const,
          fields: options.fields.map((field) => {
            if (field.path === undefined || field.analyze !== undefined)
              throw new TypeError(
                `Worker field '${field.key}' needs a path and no analyze callback; use a configured worker for custom analysis`,
              )

            return {
              key: field.key,
              label: field.label,
              type: field.type,
              path: field.path,
              options: field.options,
              freeText: field.freeText,
            }
          }),
          unknownFields: options.unknownFields,
        }
      : undefined

  const owned =
    worker ??
    new Worker(workerUrl ?? new URL('./worker-entry.js', import.meta.url), { type: 'module' })

  let nextId = 0
  let failure: Error | undefined
  const pending = new Map<number, Pending>()

  const fail = (reason: Error) => {
    failure ??= reason

    for (const waiting of pending.values()) waiting.reject(reason)
    pending.clear()
  }

  const onMessage = (event: MessageEvent) => {
    const decoded = decodeResponse(event.data)

    if (Option.isNone(decoded)) {
      const keys = Object.keys(Object(event.data)).sort().join(', ')
      fail(new Error(`Unreadable query worker response (keys: ${keys})`))

      return
    }

    const response = decoded.value
    const waiting = pending.get(response.id)

    if (!waiting) {
      if (response.ok === false) fail(new Error(response.error))

      return
    }

    pending.delete(response.id)
    waiting.resolve(response)
  }

  const onError = (event: ErrorEvent) =>
    fail(new Error(event.message || 'The query worker failed to load or execute'))

  const onMessageError = () => fail(new Error('The query worker could not deserialize a message'))

  owned.addEventListener('message', onMessage)
  owned.addEventListener('error', onError)
  owned.addEventListener('messageerror', onMessageError)

  const send = (call: WorkerCall) => {
    if (failure !== undefined) return Promise.reject(failure)

    return new Promise<WorkerResponse>((resolve, reject) => {
      nextId += 1
      const id = nextId
      pending.set(id, { resolve, reject })

      try {
        owned.postMessage({ ...call, id })
      } catch (cause) {
        pending.delete(id)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
    })
  }

  const unwrap = async <C extends WorkerCall>(
    call: C,
  ): Promise<Extract<WorkerPayload, { readonly type: C['type'] }>> => {
    const response = await send(call)

    if (response.ok === false) throw new Error(response.error)

    if (response.type !== call.type)
      throw new Error(`Unexpected query worker response for ${call.type}`)

    // SAFETY: strict decoding and the discriminant check above correlate this response with
    // its request. An undefined suggestion payload is still a successful response.
    return response as Extract<WorkerPayload, { readonly type: C['type'] }>
  }

  // Cache initialization failure without an unhandled rejection before the first query.
  // All outstanding and future calls still reject via fail/send.
  const ready =
    bootstrap === undefined ? Promise.resolve() : unwrap(bootstrap).then(() => undefined, fail)

  const invoke = async <C extends WorkerCall>(call: C) => {
    await ready

    return unwrap(call)
  }

  return {
    filter: async (text, records) => {
      const response = await invoke({ type: 'filter', text, records })

      // SAFETY: the worker filtered the exact records this call sent over a path-only schema.
      return response.matches as readonly T[]
    },
    parse: async (text) => {
      const response = await invoke({ type: 'parse', text })

      // SAFETY: the worker parsed the text this call sent with its own engine.
      return response.parsed as ParsedQuery
    },
    suggest: async (text, caret, records) => {
      const response = await invoke({ type: 'suggest', text, caret, records })

      // SAFETY: the worker suggested from the text and records this call sent.
      return response.suggestions as SuggestionList | undefined
    },
    clauses: async (text) => {
      const response = await invoke({ type: 'clauses', text })

      // SAFETY: the worker listed the clauses of the text this call sent.
      return response.clauses as readonly Clause[]
    },
    terminate: () => {
      fail(new Error('The query worker was terminated'))
      owned.removeEventListener('message', onMessage)
      owned.removeEventListener('error', onError)
      owned.removeEventListener('messageerror', onMessageError)
      owned.terminate()
    },
  }
}
