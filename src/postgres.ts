import { Match, Predicate, Result, Schema } from 'effect'
import { parseDate, parseNumber } from './core/analysis'
import { QueryTranslationError } from './core/errors'
import { findQueryField, type QueryField } from './core/fields'
import { hasErrors } from './core/parser'
import type { ParsedQuery, QueryNode, QueryValue } from './core/types'

export { QueryTranslationError } from './core/errors'

export interface PostgresColumn {
  /** One identifier, or separately quoted qualification segments such as ['orders', 'status']. */
  readonly column: string | readonly string[]
  /** Scalar storage contract: normalized text, finite double precision, or millisecond timestamptz. */
  readonly type: 'text' | 'number' | 'timestamptz'
}

export interface PostgresOptions<T> {
  readonly fields: readonly QueryField<T>[]
  /** Trusted application configuration, never query input or inferred record accessor code. */
  readonly columns: Readonly<Record<string, PostgresColumn>>
}

export type PostgresParameter = string | number

export interface PostgresQuery {
  /** A Boolean condition only, with $1-based placeholders. Does not include WHERE or SELECT. */
  readonly sql: string
  readonly params: readonly PostgresParameter[]
}

const ColumnSchema = Schema.Struct({
  column: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  type: Schema.Literals(['text', 'number', 'timestamptz']),
})

const STORAGE = { keyword: 'text', number: 'number', date: 'timestamptz' } as const

// Keep parameters as tokens until rendering: discarded optional clauses must not leave unused
// binds, and identifiers containing '$1' must never be rewritten as placeholders.
type Fragment = readonly (string | { readonly value: PostgresParameter })[]

function rejection(
  code: QueryTranslationError['code'],
  message: string,
  field?: string,
  feature?: string,
): QueryTranslationError {
  return new QueryTranslationError({ target: 'postgres', code, message, field, feature })
}

function unsupported(feature: string, field?: string): Result.Result<never, QueryTranslationError> {
  return Result.fail(
    rejection(
      'unsupported-feature',
      `PostgreSQL output does not support ${feature}`,
      field,
      feature,
    ),
  )
}

function join(fragments: readonly Fragment[], operator: 'AND' | 'OR'): Fragment {
  const first = fragments[0]

  if (fragments.length === 1 && first) return first

  const parts: (string | { readonly value: PostgresParameter })[] = ['(']

  for (const [index, fragment] of fragments.entries()) {
    if (index > 0) parts.push(` ${operator} `)
    parts.push(...fragment)
  }

  parts.push(')')

  return parts
}

function quoteColumn(
  column: PostgresColumn['column'],
  field: string,
): Result.Result<string, QueryTranslationError> {
  const segments = Match.value(column).pipe(
    Match.when(Predicate.isString, (segment) => [segment]),
    Match.orElse((qualified) => qualified),
  )

  if (
    segments.length === 0 ||
    segments.length > 4 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment.includes('\0') ||
        /[\uD800-\uDFFF]/u.test(segment) ||
        new TextEncoder().encode(segment).length > 63,
    )
  ) {
    return Result.fail(
      rejection(
        'invalid-mapping',
        'Column identifiers require 1 to 4 nonempty, NUL-free Unicode segments of at most 63 UTF-8 bytes',
        field,
      ),
    )
  }

  return Result.succeed(
    segments.map((segment) => '"' + segment.replaceAll('"', '""') + '"').join('.'),
  )
}

function numericValue(
  raw: string,
  field: string,
): Result.Result<number | undefined, QueryTranslationError> {
  const value = parseNumber(raw)

  if (value !== undefined && !Number.isFinite(value)) {
    return Result.fail(
      rejection('invalid-value', 'PostgreSQL output requires finite numeric query values', field),
    )
  }

  return Result.succeed(value)
}

function dateValue(at: number, field: string): Result.Result<string, QueryTranslationError> {
  const iso = new Date(at).toISOString()

  // PostgreSQL has no year zero. Extended positive ISO years need PostgreSQL's unsigned form.
  if (iso.startsWith('0000-') || iso.startsWith('-')) {
    return Result.fail(
      rejection('invalid-value', 'PostgreSQL output requires AD date bounds', field),
    )
  }

  return Result.succeed(iso.replace(/^\+0*(\d+)-/, '$1-'))
}

function comparison(
  column: string,
  operator: '=' | '>=' | '>' | '<=' | '<',
  value: PostgresParameter,
  cast: 'text' | 'double precision' | 'timestamptz',
): Fragment {
  return [column, ` ${operator} `, { value }, `::${cast}`]
}

function total(fragment: Fragment): Fragment {
  return ['COALESCE(', ...fragment, ', FALSE)']
}

function numericPredicate(
  column: string,
  value: QueryValue,
  field: string,
): Result.Result<Fragment, QueryTranslationError> {
  return Result.gen(function* () {
    if (value.kind === 'term' || value.kind === 'phrase') {
      const number = yield* numericValue(value.raw, field)

      return number === undefined
        ? ['FALSE']
        : total(comparison(column, '=', number, 'double precision'))
    }

    if (value.kind !== 'range') return yield* unsupported(value.kind, field)
    const lower = value.from === undefined ? undefined : yield* numericValue(value.from, field)
    const upper = value.to === undefined ? undefined : yield* numericValue(value.to, field)

    if (
      (value.from !== undefined && lower === undefined) ||
      (value.to !== undefined && upper === undefined)
    ) {
      return ['FALSE']
    }

    const bounds: Fragment[] = []

    if (lower !== undefined)
      bounds.push(comparison(column, value.includeLower ? '>=' : '>', lower, 'double precision'))

    if (upper !== undefined)
      bounds.push(comparison(column, value.includeUpper ? '<=' : '<', upper, 'double precision'))

    return bounds.length === 0 ? [column, ' IS NOT NULL'] : total(join(bounds, 'AND'))
  })
}

function datePredicate(
  column: string,
  value: QueryValue,
  field: string,
): Result.Result<Fragment, QueryTranslationError> {
  return Result.gen(function* () {
    if (value.kind === 'term' || value.kind === 'phrase') {
      const window = parseDate(value.raw)

      if (!window) return ['FALSE']
      const from = yield* dateValue(window.from, field)
      const to = yield* dateValue(window.to, field)

      return total(
        join(
          [
            comparison(column, '>=', from, 'timestamptz'),
            comparison(column, '<', to, 'timestamptz'),
          ],
          'AND',
        ),
      )
    }

    if (value.kind !== 'range') return yield* unsupported(value.kind, field)
    const lower = value.from === undefined ? undefined : parseDate(value.from)
    const upper = value.to === undefined ? undefined : parseDate(value.to)

    if (
      (value.from !== undefined && lower === undefined) ||
      (value.to !== undefined && upper === undefined)
    ) {
      return ['FALSE']
    }

    const bounds: Fragment[] = []

    if (lower) {
      const from = yield* dateValue(value.includeLower ? lower.from : lower.to, field)
      bounds.push(comparison(column, '>=', from, 'timestamptz'))
    }

    if (upper) {
      const to = yield* dateValue(value.includeUpper ? upper.to : upper.from, field)
      bounds.push(comparison(column, '<', to, 'timestamptz'))
    }

    return bounds.length === 0 ? [column, ' IS NOT NULL'] : total(join(bounds, 'AND'))
  })
}

function fieldPredicate<T>(
  field: QueryField<T>,
  value: QueryValue,
  columns: PostgresOptions<T>['columns'],
): Result.Result<Fragment, QueryTranslationError> {
  return Result.gen(function* () {
    if (field.type === 'text') return yield* unsupported('text analysis', field.key)

    if (value.kind === 'phrase' && value.proximity !== undefined)
      return yield* unsupported('phrase proximity', field.key)

    if (value.kind === 'wildcard' || value.kind === 'fuzzy' || value.kind === 'regex')
      return yield* unsupported(value.kind, field.key)

    const configured = Object.hasOwn(columns, field.key) ? columns[field.key] : undefined

    if (!configured)
      return yield* Result.fail(
        rejection('unmapped-field', 'No PostgreSQL column is mapped for this field', field.key),
      )

    const mapping = yield* Result.mapError(
      Schema.decodeUnknownResult(ColumnSchema, { onExcessProperty: 'error' })(configured),
      (error) => rejection('invalid-mapping', error.message, field.key),
    )

    const storage = STORAGE[field.type]

    if (mapping.type !== storage) {
      return yield* Result.fail(
        rejection('invalid-mapping', `Field requires ${storage} scalar storage`, field.key),
      )
    }

    const column = yield* quoteColumn(mapping.column, field.key)

    if (field.type === 'number') return yield* numericPredicate(column, value, field.key)

    if (field.type === 'date') return yield* datePredicate(column, value, field.key)

    if (value.kind === 'range') return yield* unsupported('keyword ranges', field.key)

    if (value.raw.includes('\0') || /[\uD800-\uDFFF]/u.test(value.raw))
      return yield* Result.fail(
        rejection(
          'invalid-value',
          'PostgreSQL text must be NUL-free, well-formed Unicode',
          field.key,
        ),
      )

    if (value.raw.trim() === '') return ['FALSE']

    return total(comparison(column + ' COLLATE "C"', '=', value.raw, 'text'))
  })
}

function term<T>(
  node: Extract<QueryNode, { readonly type: 'term' }>,
  options: PostgresOptions<T>,
): Result.Result<Fragment, QueryTranslationError> {
  if (node.field === '*' && node.value.kind === 'wildcard' && node.value.raw === '*') {
    return Result.succeed(['TRUE'])
  }

  return Result.gen(function* () {
    if (node.field === undefined) {
      const fragments: Fragment[] = []

      for (const field of options.fields) {
        if (field.freeText)
          fragments.push(yield* fieldPredicate(field, node.value, options.columns))
      }

      return fragments.length === 0 ? ['FALSE'] : join(fragments, 'OR')
    }

    const field = findQueryField(options.fields, node.field)

    // The language deliberately permits unknown fields; a warning still means match-none.
    return field ? yield* fieldPredicate(field, node.value, options.columns) : ['FALSE']
  })
}

function translate<T>(
  node: QueryNode | undefined,
  options: PostgresOptions<T>,
): Result.Result<Fragment, QueryTranslationError> {
  return Result.gen(function* () {
    if (!node) return ['TRUE']

    if (node.boost !== undefined) return yield* unsupported('boosts')

    if (node.type === 'term') return yield* term(node, options)

    const required: Fragment[] = []
    const optional: Fragment[] = []
    const excluded: Fragment[] = []

    for (const clause of node.clauses) {
      // Validate every clause, including optional clauses that do not affect an already-required
      // match. Discard their tokens, not their feature errors.
      const fragment = yield* translate(clause.node, options)

      if (clause.occur === 'must') required.push(fragment)
      else if (clause.occur === 'must-not') excluded.push(fragment)
      else optional.push(fragment)
    }

    const positive =
      required.length > 0
        ? join(required, 'AND')
        : optional.length > 0
          ? join(optional, 'OR')
          : undefined

    if (!positive) return ['FALSE'] // A group containing only prohibited clauses never matches.

    if (excluded.length === 0) return positive

    return join([positive, ...excluded.map((fragment) => ['NOT (', ...fragment, ')'])], 'AND')
  })
}

/** Pure translation. No SQL is executed and no application table or authorization rule is inferred. */
export function toPostgres<T>(
  parsed: ParsedQuery,
  options: PostgresOptions<T>,
): Result.Result<PostgresQuery, QueryTranslationError> {
  if (hasErrors(parsed)) {
    return Result.fail(
      rejection(
        'invalid-query',
        parsed.diagnostics
          .filter((entry) => entry.severity === 'error')
          .map((entry) => entry.message)
          .join('; '),
      ),
    )
  }

  return Result.map(translate(parsed.node, options), (fragment) => {
    const params: PostgresParameter[] = []
    let sql = ''

    for (const part of fragment) {
      sql += Match.value(part).pipe(
        Match.when(Predicate.isString, (text) => text),
        Match.orElse((parameter) => {
          params.push(parameter.value)

          return `$${params.length}`
        }),
      )
    }

    return { sql, params }
  })
}
