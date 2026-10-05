import { QueryValueError } from './errors'
import { quoteLiteral } from './quote'

const RESERVED = /[\s+\-!(){}[\]^"~*?:\\/|&]/u

const RESERVED_UNESCAPED = /[\s+\-!(){}[\]^"~*?:\\/|&]/gu

const RESERVED_WORD = /^(?:AND|OR|NOT|TO)$/

/**
 * Renders a value as a term the parser reads back verbatim. Anything reserved is quoted, which
 * also makes a wildcard or operator inside user input literal, so a value can never widen a query.
 */
export function escapeTerm(value: string): string {
  return value === '' || RESERVED.test(value) || RESERVED_WORD.test(value)
    ? quoteLiteral(value)
    : value
}

/** Escapes a field name. Field names cannot be quoted, so each reserved character is escaped. */
export function escapeFieldName(field: string): string {
  if (field === '') throw new QueryValueError({ message: 'A query field name cannot be empty' })

  const escaped = field.replace(RESERVED_UNESCAPED, '\\$&')

  return RESERVED_WORD.test(escaped) ? `\\${escaped}` : escaped
}

export type FieldClause = {
  readonly field: string
  readonly value: string
  /** `> 0`; local filtering does not rank, so it only round-trips. */
  readonly boost?: number
  /** Edit distance 0-2 for `value~n`. */
  readonly fuzzy?: number
  /** Allowed term distance for `"value"~n`. */
  readonly proximity?: number
}

function positiveNumber(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined

  if (!Number.isFinite(value) || value <= 0)
    throw new QueryValueError({ message: `Query clause ${label} must be positive and finite` })

  return value
}

/** Builds one `field:value` clause, escaping both sides so the pair stays a single condition. */
export function fieldClause({ field, value, boost, fuzzy, proximity }: FieldClause): string {
  if (proximity !== undefined && fuzzy !== undefined)
    throw new QueryValueError({
      message: 'A query clause cannot be both a phrase and a fuzzy term',
    })

  positiveNumber(boost, 'boost')

  let text = proximity === undefined ? escapeTerm(value) : quoteLiteral(value)

  if (fuzzy !== undefined) text += `~${fuzzy}`

  if (proximity !== undefined) text += `~${proximity}`

  return `${escapeFieldName(field)}:${text}${boost === undefined ? '' : `^${boost}`}`
}

/**
 * Joins clauses with `AND`. Two or more parts are parenthesized so the result can be nested inside
 * `or`, `not`, or a group without changing what it means. Empty input yields the empty query.
 */
export function and(...clauses: readonly string[]): string {
  return group('AND', clauses)
}

/** Joins clauses with `OR`, parenthesized for the same reason as {@link and}. */
export function or(...clauses: readonly string[]): string {
  return group('OR', clauses)
}

function group(operator: 'AND' | 'OR', clauses: readonly string[]): string {
  const present = clauses.filter((clause) => clause !== '')

  if (present.length === 0) return ''

  if (present.length === 1) return present[0] ?? ''

  return `(${present.join(` ${operator} `)})`
}

/** Negates one clause. Negating nothing yields the empty query rather than a broken one. */
export function not(clause: string): string {
  return clause === '' ? '' : `NOT ${clause}`
}
