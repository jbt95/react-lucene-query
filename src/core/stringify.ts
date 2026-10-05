import { Match } from 'effect'
import { QueryValueError } from './errors'
import { quoteLiteral } from './quote'
import type { QueryClause, QueryNode, QueryValue } from './types'

function escapeTerm(raw: string): string {
  if (!raw.length)
    throw new QueryValueError({ message: 'An unquoted Lucene term or field cannot be empty' })
  const escaped = raw.replace(/[\s+\-!(){}[\]^"~*?:\\/|&]/gu, '\\$&')

  return /^(AND|OR|NOT)$/.test(escaped) ? `\\${escaped}` : escaped
}

function wildcardSource(raw: string): string {
  let result = ''

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw.charAt(index)

    if (char === '\\') {
      const size = raw.charAt(index + 1) === 'u' ? 6 : 2
      result += raw.slice(index, index + size)
      index += size - 1
    } else if (char === '*' || char === '?') result += char
    else result += char.replace(/[\s+\-!(){}[\]^"~:\\/|&]/gu, '\\$&')
  }

  return result
}

function regexSource(raw: string): string {
  let result = ''

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw.charAt(index)

    if (char === '\\') {
      result += raw.slice(index, index + 2)
      index += 1
    } else result += char === '/' ? '\\/' : char
  }

  return result
}

const stringifyValue = Match.type<QueryValue>().pipe(
  Match.discriminatorsExhaustive('kind')({
    term: (value) => escapeTerm(value.raw),
    phrase: (value) =>
      quoteLiteral(value.raw) + (value.proximity === undefined ? '' : `~${value.proximity}`),
    fuzzy: (value) =>
      escapeTerm(value.raw) + '~' + (value.distance === undefined ? '' : value.distance),
    wildcard: (value) => wildcardSource(value.raw),
    regex: (value) => `/${regexSource(value.raw)}/`,
    range: (value) => {
      const from = value.from === undefined ? '*' : quoteLiteral(value.from)
      const to = value.to === undefined ? '*' : quoteLiteral(value.to)

      return `${value.includeLower ? '[' : '{'}${from} TO ${to}${value.includeUpper ? ']' : '}'}`
    },
  }),
)

function stringifyField(field: string | undefined): string {
  if (field === undefined) return ''

  if (field === '*') return '*:'

  return `${escapeTerm(field)}:`
}

function occurrencePrefix(occur: QueryClause['occur']): string {
  if (occur === 'must') return '+'

  if (occur === 'must-not') return '-'

  return ''
}

// Occurrence prefixes preserve classic Boolean semantics without operator precedence guesses.
export function stringifyQuery(node: QueryNode | undefined): string {
  if (!node) return ''
  let text: string

  if (node.type === 'term') {
    text = stringifyField(node.field) + stringifyValue(node.value)
  } else {
    if (!node.clauses.length)
      throw new QueryValueError({
        message: 'A Lucene Boolean group must have at least one clause',
      })
    text =
      '(' +
      node.clauses
        .map((clause) => occurrencePrefix(clause.occur) + stringifyQuery(clause.node))
        .join(' ') +
      ')'
  }

  if (node.boost !== undefined) {
    if (!Number.isFinite(node.boost) || node.boost <= 0)
      throw new QueryValueError({ message: 'Boost must be positive and finite' })
    text += `^${node.boost}`
  }

  return text
}
