import { Data, Effect, Option, Result, Schema } from 'effect'
import { listClauses, type Clause } from './clauses'
import { scalarText, tryCompileQuery } from './evaluate'
import { facetCounts, type FacetOptions, type FacetCounts } from './facets'
import { QUERY_FIELD_TYPES, fieldValues, type QueryField } from './fields'
import { hasErrors, parseQuery, type UnknownFieldMode } from './parser'
import { getSuggestions, type SuggestionList } from './suggest'
import { DIAGNOSTIC_SEVERITIES } from './types'
import type { ParsedQuery } from './types'

/** Never crosses a wire, so a plain tagged error is enough. */
export class QueryConfigurationError extends Data.TaggedError('QueryConfigurationError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Schema-backed because this is the one error a client receives from a server (`InvalidQueryError`
 * is encoded on the wire in the example backend). Declaring it here means the wire shape is derived
 * from the error rather than restated beside it.
 */
const QueryDiagnosticSchema = Schema.Struct({
  start: Schema.Int,
  end: Schema.Int,
  message: Schema.String,
  severity: Schema.Literals(DIAGNOSTIC_SEVERITIES),
})

export class InvalidQueryError extends Schema.TaggedError<InvalidQueryError>()(
  'InvalidQueryError',
  {
    query: Schema.String,
    diagnostics: Schema.Array(QueryDiagnosticSchema),
  },
) {
  override get message() {
    return this.diagnostics.map((entry) => entry.message).join('; ')
  }
}

export interface CompiledQuery<T> {
  readonly parsed: ParsedQuery
  readonly test: (record: T) => boolean
}

/** Execution seam: adapters preserve their own typed error and environment requirements. */
export type SearchAdapter<A, E = never, R = never> = (query: ParsedQuery) => Effect.Effect<A, E, R>

export interface QueryEngine<T> {
  readonly fields: readonly QueryField<T>[]
  /** Pure, tolerant editor parsing. Diagnostics are data, not failed Effects. */
  readonly parse: (text: string) => ParsedQuery
  readonly compile: (text: string) => Effect.Effect<CompiledQuery<T>, InvalidQueryError>
  readonly filter: (
    text: string,
    records: readonly T[],
  ) => Effect.Effect<readonly T[], InvalidQueryError>
  readonly suggest: (
    text: string,
    caret: number,
    records?: readonly T[],
  ) => Option.Option<SuggestionList>
  readonly search: <A, E, R>(
    text: string,
    adapter: SearchAdapter<A, E, R>,
  ) => Effect.Effect<A, InvalidQueryError | E, R>
  readonly facets: (
    text: string,
    records: readonly T[],
    options?: FacetOptions,
  ) => Effect.Effect<FacetCounts, InvalidQueryError>
  readonly clauses: (text: string) => readonly Clause[]
}

export interface QueryEngineOptions<T> {
  readonly fields: readonly QueryField<T>[]
  /** How an unconfigured field name is reported. Defaults to a "did you mean" warning. */
  readonly unknownFields?: UnknownFieldMode
}

// JavaScript consumers reach this boundary without type checking, so the configuration is
// decoded rather than trusted. Only the fields that fail silently are checked: a mistyped
// `type` would otherwise turn a keyword field into an analyzed text field and return wrong
// rows. `read` stays unvalidated because a non-callable accessor throws on first use, which
// is already a loud defect, and Schema has no function schema.
const FieldConfiguration = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  type: Schema.Literals(QUERY_FIELD_TYPES),
  options: Schema.optional(Schema.Array(Schema.String)),
  freeText: Schema.optional(Schema.Boolean),
})

const FieldConfigurations = Schema.Array(FieldConfiguration)

/**
 * The rules a Struct cannot express, in one place next to the Struct. Each returns the message the
 * engine reports, so a configuration mistake still names the field that caused it.
 */
function configurationIssue<T>(field: QueryField<T>): string | undefined {
  const hasRead = field.read !== undefined
  const hasPath = field.path !== undefined

  // Exactly one accessor: neither would silently match nothing, and both is ambiguous.
  if (hasRead === hasPath) return `Query field '${field.key}' needs exactly one of read or path`

  if (hasPath && field.path === '')
    return `Query field '${field.key}' needs exactly one of read or path`

  return undefined
}

/**
 * Traced where the work is observable, eager-where-it-is-CPU. `make` and `search` are traced
 * because a misconfigured schema and an adapter call are both things an operator wants to see;
 * `compile`, `filter` and `facets` run untraced-eager because they are pure CPU over caller data
 * and pay a span per call on every keystroke in the editor.
 */
const makeEngine = Effect.fn(function* <T>({
  fields,
  unknownFields = 'suggest',
}: QueryEngineOptions<T>): Effect.fn.Return<QueryEngine<T>, QueryConfigurationError> {
  yield* Schema.decodeUnknownEffect(FieldConfigurations)(fields).pipe(
    Effect.mapError(
      (cause) =>
        new QueryConfigurationError({
          message: `Invalid query field configuration: ${cause.message}`,
          cause,
        }),
    ),
  )

  const keys = new Set<string>()

  for (const field of fields) {
    if (field.key === '' || keys.has(field.key)) {
      return yield* Effect.fail(
        new QueryConfigurationError({
          message: `Query field keys must be nonempty and unique: ${field.key}`,
        }),
      )
    }

    const issue = configurationIssue(field)

    if (issue !== undefined)
      return yield* Effect.fail(new QueryConfigurationError({ message: issue }))

    keys.add(field.key)
  }

  const parse = (text: string) => parseQuery(text, fields, { unknownFields })

  const compile = Effect.fnUntracedEager(function* (
    text: string,
  ): Effect.fn.Return<CompiledQuery<T>, InvalidQueryError> {
    const parsed = parse(text)

    if (hasErrors(parsed)) {
      return yield* Effect.fail(
        new InvalidQueryError({ query: text, diagnostics: parsed.diagnostics }),
      )
    }

    // Both compile failures are typed, so this maps every expected rejection into a diagnostic and
    // nothing escapes as a defect.
    const compiled = tryCompileQuery(parsed.node, fields)

    if (Result.isFailure(compiled)) {
      return yield* Effect.fail(
        new InvalidQueryError({
          query: text,
          diagnostics: [
            ...parsed.diagnostics,
            { start: 0, end: text.length, severity: 'error', message: compiled.failure.message },
          ],
        }),
      )
    }

    return { parsed, test: compiled.success }
  })

  // Arrays and records are immutable inputs: replacing the array invalidates the lazy index.
  const indexes = new WeakMap<readonly T[], Map<string, ReadonlyMap<string, number>>>()

  const suggest = (
    text: string,
    caret: number,
    records: readonly T[] = [],
  ): Option.Option<SuggestionList> => {
    let index = indexes.get(records)

    if (!index) {
      index = new Map()
      indexes.set(records, index)
    }

    const list = getSuggestions(text, caret, fields, records, {
      getValues: (field) => {
        const cached = index.get(field.key)

        if (cached) return cached
        const counts = new Map<string, number>()

        for (const record of records) {
          for (const value of fieldValues(field, record)) {
            const text = scalarText(value)

            if (text === undefined) continue
            counts.set(text, (counts.get(text) ?? 0) + 1)
          }
        }

        index.set(field.key, counts)

        return counts
      },
    })

    return list
  }

  const filter = Effect.fnUntracedEager(function* (text: string, records: readonly T[]) {
    const compiled = yield* compile(text)

    return records.filter(compiled.test)
  })

  const search = Effect.fn(function* <A, E, R>(text: string, adapter: SearchAdapter<A, E, R>) {
    const compiled = yield* compile(text)

    return yield* adapter(compiled.parsed)
  })

  const facets = Effect.fnUntracedEager(function* (
    text: string,
    records: readonly T[],
    options: FacetOptions = {},
  ) {
    const compiled = yield* compile(text)

    return facetCounts(compiled.test, fields, records, options)
  })

  const clauses = (text: string) => listClauses(parse(text).node)

  return { fields, parse, compile, filter, suggest, search, facets, clauses }
})

export const QueryEngine = { make: makeEngine }
