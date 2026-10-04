import { Data, Effect, Option } from 'effect'
import { currentDate, parseIsoDate } from './date'
import { compileQuery } from './query-evaluate'
import type { QueryField } from './query-fields'
import { hasErrors, parseQuery } from './query-parser'
import { getSuggestions, type SuggestionList } from './query-suggest'
import type { ParsedQuery, QueryDiagnostic } from './query-types'

export class QueryConfigurationError extends Data.TaggedError('QueryConfigurationError')<{
  readonly message: string
}> {}

export class InvalidQueryError extends Data.TaggedError('InvalidQueryError')<{
  readonly query: string
  readonly diagnostics: readonly QueryDiagnostic[]
}> {
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
  readonly today: string
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
}

export interface QueryEngineOptions<T> {
  readonly fields: readonly QueryField<T>[]
  /** ISO day used for relative dates. Defaults to the local day when creation is run. */
  readonly today?: string
}

const makeEngine = Effect.fnUntraced(function* <T>({
  fields,
  today: fixedToday,
}: QueryEngineOptions<T>): Effect.fn.Return<QueryEngine<T>, QueryConfigurationError> {
  const today = fixedToday ?? currentDate()

  if (!parseIsoDate(today)) {
    return yield* Effect.fail(
      new QueryConfigurationError({ message: 'today must be a valid yyyy-MM-dd date' }),
    )
  }

  const keys = new Set<string>()

  for (const field of fields) {
    const key = field.key.toLowerCase()

    if (!/^[a-z_][a-z0-9_.]*$/.test(key) || keys.has(key)) {
      return yield* Effect.fail(
        new QueryConfigurationError({ message: `Invalid or duplicate query field: ${field.key}` }),
      )
    }

    keys.add(key)
  }

  const parse = (text: string) => parseQuery(text, fields, today)

  const compile = Effect.fnUntraced(function* (
    text: string,
  ): Effect.fn.Return<CompiledQuery<T>, InvalidQueryError> {
    const parsed = parse(text)

    if (hasErrors(parsed)) {
      return yield* Effect.fail(
        new InvalidQueryError({ query: text, diagnostics: parsed.diagnostics }),
      )
    }

    return { parsed, test: compileQuery(parsed.node, fields, today) }
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
          const value = field.read(record)

          if (value != null) {
            const text = String(value)
            counts.set(text, (counts.get(text) ?? 0) + 1)
          }
        }

        index.set(field.key, counts)

        return counts
      },
    })

    return Option.fromUndefinedOr(list)
  }

  const filter = Effect.fnUntraced(function* (text: string, records: readonly T[]) {
    const compiled = yield* compile(text)

    return records.filter(compiled.test)
  })

  const search = Effect.fnUntraced(function* <A, E, R>(
    text: string,
    adapter: SearchAdapter<A, E, R>,
  ) {
    const compiled = yield* compile(text)

    return yield* adapter(compiled.parsed)
  })

  return { fields, today, parse, compile, filter, suggest, search }
})

export const QueryEngine = { make: makeEngine }
