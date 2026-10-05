import { Match, Result } from 'effect'
import { analyzeText, compareTerms, parseDate, parseNumber } from './analysis'
import { QueryValueError, RegexSyntaxError } from './errors'
import {
  fieldValues,
  findQueryField,
  type QueryField,
  type QueryFieldScalar,
  type QueryFieldType,
} from './fields'
import { compileFuzzy } from './fuzzy'
import { compilePhrase } from './phrase'
import { compileRegex } from './regexp'
import type { QueryNode, QueryValue } from './types'
import { compileWildcard } from './wildcard'

/** One compiled piece already knows which fields it reads and how to test one value. */
type Matcher<T> = (record: T) => boolean

type FieldPredicate = (value: QueryFieldScalar) => boolean

type Analyzer = (text: string) => readonly string[]

/** Missing and blank values never match, matching how Lucene skips unindexed tokens. */
export function scalarText(value: QueryFieldScalar): string | undefined {
  if (value == null) return undefined
  const text = String(value).trim()

  return text === '' ? undefined : text
}

/** A multi-valued field matches when any one of its values matches. */
function fieldMatch<T>(field: QueryField<T>, predicate: FieldPredicate, record: T): boolean {
  for (const value of fieldValues(field, record)) {
    if (predicate(value)) return true
  }

  return false
}

/** Keyword fields keep the whole scalar string and compare it case-sensitively. */
function keywordPredicate(value: QueryValue): FieldPredicate {
  if (value.kind === 'range') {
    const { from, to, includeLower, includeUpper } = value

    return (actual) => {
      const text = scalarText(actual)

      if (text === undefined) return false

      if (from !== undefined) {
        const order = compareTerms(text, from)

        if (order < 0 || (order === 0 && !includeLower)) return false
      }

      if (to !== undefined) {
        const order = compareTerms(text, to)

        if (order > 0 || (order === 0 && !includeUpper)) return false
      }

      return true
    }
  }

  if (value.kind === 'term' || value.kind === 'phrase') {
    return (actual) => scalarText(actual) === value.raw
  }

  if (value.kind === 'wildcard') {
    const matches = compileWildcard(value.raw)

    return (actual) => {
      const text = scalarText(actual)

      return text !== undefined && matches(text)
    }
  }

  if (value.kind === 'fuzzy') {
    const matches = compileFuzzy(value.raw, value.distance)

    return (actual) => {
      const text = scalarText(actual)

      return text !== undefined && matches(text)
    }
  }

  const matches = compileRegex(value.raw)

  return (actual) => {
    const text = scalarText(actual)

    return text !== undefined && matches(text)
  }
}

/** `number` fields compare numerically, so `units:1,000` cannot masquerade as `1000`. */
function numberPredicate(value: QueryValue): FieldPredicate {
  if (value.kind === 'range') {
    const lower = value.from === undefined ? undefined : parseNumber(value.from)
    const upper = value.to === undefined ? undefined : parseNumber(value.to)

    // A bound that is not a number cannot be satisfied, rather than being skipped.
    if (
      (value.from !== undefined && lower === undefined) ||
      (value.to !== undefined && upper === undefined)
    ) {
      return () => false
    }

    return (actual) => {
      const text = scalarText(actual)
      const number = text === undefined ? undefined : parseNumber(text)

      if (number === undefined) return false

      if (lower !== undefined && (number < lower || (number === lower && !value.includeLower))) {
        return false
      }

      if (upper !== undefined && (number > upper || (number === upper && !value.includeUpper))) {
        return false
      }

      return true
    }
  }

  if (value.kind === 'term' || value.kind === 'phrase') {
    const expected = parseNumber(value.raw)

    return (actual) => {
      const text = scalarText(actual)

      return text !== undefined && expected !== undefined && parseNumber(text) === expected
    }
  }

  // Patterns over a numeric value are ambiguous rather than supported: `*` is not a digit wildcard.
  return () => false
}

/** `date` fields match instants, and a partially written date covers its whole window. */
function datePredicate(value: QueryValue): FieldPredicate {
  // A calendar form wins over epoch milliseconds, so `due:2026` means the year 2026 rather
  // than 2 seconds after the epoch. Only text that cannot read as a date is taken as epoch.
  const instant = (scalar: QueryFieldScalar): number | undefined => {
    const text = scalarText(scalar)

    if (text === undefined) return undefined

    const window = parseDate(text)

    if (window) return window.from

    const asNumber = Number(text)

    return Number.isNaN(asNumber) ? undefined : asNumber
  }

  if (value.kind === 'range') {
    const lower = value.from === undefined ? undefined : parseDate(value.from)
    const upper = value.to === undefined ? undefined : parseDate(value.to)

    if ((value.from !== undefined && !lower) || (value.to !== undefined && !upper)) {
      return () => false
    }

    return (actual) => {
      const at = instant(actual)

      if (at === undefined) return false

      // An inclusive bound covers its whole window; an exclusive bound skips it entirely.
      if (lower && at < (value.includeLower ? lower.from : lower.to)) return false

      if (upper && at >= (value.includeUpper ? upper.to : upper.from)) return false

      return true
    }
  }

  if (value.kind === 'term' || value.kind === 'phrase') {
    const window = parseDate(value.raw)

    return (actual) => {
      const at = instant(actual)

      return window !== undefined && at !== undefined && at >= window.from && at < window.to
    }
  }

  return () => false
}

/** Classic parsing generates one optional term per analyzed token instead of a phrase. */
function tokenPredicates(
  value: QueryValue,
  analyze: Analyzer,
): readonly ((token: string) => boolean)[] {
  return Match.value(value).pipe(
    Match.discriminatorsExhaustive('kind')({
      term: (matched) => analyze(matched.raw).map((term) => (token: string) => token === term),
      wildcard: (matched) => [compileWildcard(matched.raw)],
      fuzzy: (fuzzy) => analyze(fuzzy.raw).map((term) => compileFuzzy(term, fuzzy.distance)),
      regex: (matched) => [compileRegex(matched.raw)],
      // A phrase is one optional predicate over token positions, and a range is not a term at all;
      // both are handled by textPredicate before this point.
      phrase: () => [],
      range: () => [],
    }),
  )
}

/** Text fields are analyzed into lowercase Unicode letter/digit tokens before comparison. */
function textPredicate(value: QueryValue, analyze: Analyzer): FieldPredicate {
  if (value.kind === 'range') {
    const { from, to, includeLower, includeUpper } = value

    return (actual) => {
      const text = scalarText(actual)

      if (text === undefined) return false

      return analyze(text).some((token) => {
        if (from !== undefined) {
          const order = compareTerms(token, from)

          if (order < 0 || (order === 0 && !includeLower)) return false
        }

        if (to !== undefined) {
          const order = compareTerms(token, to)

          if (order > 0 || (order === 0 && !includeUpper)) return false
        }

        return true
      })
    }
  }

  if (value.kind === 'phrase') {
    const matches = compilePhrase(analyze(value.raw), value.proximity)

    return (actual) => {
      const text = scalarText(actual)

      return text !== undefined && matches(analyze(text))
    }
  }

  // Only ordinary/fuzzy terms are analyzed; pattern syntax is a whole-token matcher.
  const matches = tokenPredicates(value, analyze)

  return (actual) => {
    const text = scalarText(actual)

    if (text === undefined) return false
    const tokens = analyze(text)

    for (const predicate of matches) {
      if (tokens.some(predicate)) return true
    }

    return false
  }
}

/**
 * The four indexed field types, each answering with its own comparison. A fifth type must appear
 * here: `satisfies Record<QueryFieldType, …>` refuses a table that is missing one, and indexing by
 * `field.type` needs no cast because every field carries an analyzer or none.
 */
type Analyzed = { readonly analyze?: (value: string) => readonly string[] }

const FIELD_PREDICATES = {
  keyword: (_field: Analyzed, value: QueryValue) => keywordPredicate(value),
  number: (_field: Analyzed, value: QueryValue) => numberPredicate(value),
  date: (_field: Analyzed, value: QueryValue) => datePredicate(value),
  text: (field: Analyzed, value: QueryValue) => textPredicate(value, field.analyze ?? analyzeText),
} satisfies Record<QueryFieldType, (field: Analyzed, value: QueryValue) => FieldPredicate>

function fieldPredicate<T>(field: QueryField<T>, value: QueryValue): FieldPredicate {
  return FIELD_PREDICATES[field.type](field, value)
}

function anyField<T>(fields: readonly QueryField<T>[], value: QueryValue): Matcher<T> {
  if (fields.length === 0) return () => false
  const predicates = fields.map((field) => fieldPredicate(field, value))

  return (record) => {
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index]
      const predicate = predicates[index]

      if (field && predicate && fieldMatch(field, predicate, record)) return true
    }

    return false
  }
}

function compileTerm<T>(
  node: Extract<QueryNode, { type: 'term' }>,
  fields: readonly QueryField<T>[],
): Matcher<T> {
  // `*:*` is Lucene's documented match-everything query.
  if (node.field === '*' && node.value.kind === 'wildcard' && node.value.raw === '*') {
    return () => true
  }

  if (node.field === undefined) {
    return anyField(
      fields.filter((field) => field.freeText),
      node.value,
    )
  }

  const field = findQueryField(fields, node.field)

  if (!field) return () => false

  const predicate = fieldPredicate(field, node.value)

  return (record) => fieldMatch(field, predicate, record)
}

/** Compile an AST into a reusable predicate. Records stay immutable inputs. */
export function compileQuery<T>(
  node: QueryNode | undefined,
  fields: readonly QueryField<T>[],
): Matcher<T> {
  if (!node) return () => true

  if (node.type === 'term') return compileTerm(node, fields)

  const required: Matcher<T>[] = []
  const optional: Matcher<T>[] = []
  const excluded: Matcher<T>[] = []

  for (const clause of node.clauses) {
    const predicate = compileQuery(clause.node, fields)

    if (clause.occur === 'must') required.push(predicate)
    else if (clause.occur === 'must-not') excluded.push(predicate)
    else optional.push(predicate)
  }

  return (record) => {
    for (const predicate of required) {
      if (!predicate(record)) return false
    }

    for (const predicate of excluded) {
      if (predicate(record)) return false
    }

    if (required.length > 0) return true

    return optional.some((predicate) => predicate(record))
  }
}

/**
 * Compiling can fail on a hand-built node — a wildcard escape that never closes, a fuzzy distance
 * above two. The parsed path validates all of these first, so this seam exists for callers that
 * build an AST themselves: it names the failure instead of throwing it past an error channel.
 */
export function tryCompileQuery<T>(
  node: QueryNode | undefined,
  fields: readonly QueryField<T>[],
): Result.Result<Matcher<T>, QueryValueError | RegexSyntaxError> {
  return Result.mapError(
    Result.try(() => compileQuery(node, fields)),
    (error) =>
      Match.value(error).pipe(
        Match.when(Match.instanceOf(QueryValueError), (cause) => cause),
        Match.when(Match.instanceOf(RegexSyntaxError), (cause) => cause),
        // A failure this package did not author is still a value the caller must see, not a defect
        // that vanishes at the next runSync.
        Match.orElse(
          () =>
            new QueryValueError({
              message: error instanceof Error ? error.message : String(error),
            }),
        ),
      ),
  )
}

export function matchesQuery<T>(
  node: QueryNode | undefined,
  fields: readonly QueryField<T>[],
  record: T,
): boolean {
  return compileQuery(node, fields)(record)
}

export function filterRecords<T>(
  node: QueryNode | undefined,
  fields: readonly QueryField<T>[],
  records: readonly T[],
): readonly T[] {
  return node === undefined ? records : records.filter(compileQuery(node, fields))
}
