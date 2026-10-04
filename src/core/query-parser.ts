import { Temporal } from '@js-temporal/polyfill'
import { closestFieldKey, findQueryField, validateValue, type QueryField } from './query-fields'
import { tokenize, tokenValue } from './query-tokenizer'
import type {
  CompareOperator,
  DiagnosticSeverity,
  ParsedQuery,
  QueryDiagnostic,
  QueryNode,
  QueryTermSpan,
  QueryToken,
  QueryValue,
  TokenRole,
} from './query-types'

// Grammar (Lucene / Datadog flavoured). Whitespace between conditions means AND.
//
//   query   := or
//   or      := and ( "OR" and )*
//   and     := unary ( [ "AND" ] unary )*
//   unary   := ( "NOT" | "-" ) unary | "(" query ")" | term
//   term    := FIELD ":" value | value
//   value   := word | "quoted" | ( ">" | ">=" | "<" | "<=" ) word
//            | "[" word "TO" word "]" | "(" value ( "OR" value )* ")"   (list only after FIELD ":")
//
// The parser never throws. A half-typed query still yields tokens, roles and diagnostics, because
// the editor reparses on every keystroke and has to colour whatever exists so far.

type ParsedValue = {
  readonly value: QueryValue | undefined
  readonly end: number
  readonly invalid: boolean
}

type Operand = {
  readonly raw: string
  readonly end: number
  readonly invalid: boolean
}

function toCompareOperator(text: string): CompareOperator | undefined {
  switch (text) {
    case '>':
    case '>=':
    case '<':
    case '<=':
      return text
    default:
      return undefined
  }
}

type LiteralToken = QueryToken & { readonly kind: 'text' | 'quoted' }

function isLiteral(token: QueryToken | undefined): token is LiteralToken {
  return token?.kind === 'text' || token?.kind === 'quoted'
}

function isKeyword(token: QueryToken | undefined, word: string): boolean {
  return token?.kind === 'operator' && token.text === word
}

function startsUnary(token: QueryToken | undefined): boolean {
  if (!token) return false

  return (
    token.kind === 'field' ||
    token.kind === 'text' ||
    token.kind === 'quoted' ||
    token.kind === 'minus' ||
    token.kind === 'lparen' ||
    token.kind === 'compare' ||
    (token.kind === 'operator' && token.text === 'NOT')
  )
}

function combine(type: 'and' | 'or', children: readonly QueryNode[]): QueryNode | undefined {
  const [first] = children

  if (!first) return undefined

  if (children.length === 1) return first

  return { type, children }
}

function unexpectedMessage(token: QueryToken): string {
  switch (token.kind) {
    case 'rparen':
      return 'Unmatched )'
    case 'rbracket':
      return 'Unmatched ]'
    case 'colon':
      return 'Unexpected :'
    default:
      return `Unexpected ${token.text}`
  }
}

export function parseQuery<T>(
  text: string,
  fields: readonly QueryField<T>[],
  today: string = Temporal.Now.plainDateISO().toString(),
): ParsedQuery {
  // Reject oversized input before allocating a token stream.
  const tokens = text.length > 32768 ? [] : tokenize(text)
  const groups: number[] = []
  let depth = 0
  let unaryDepth = 0
  let maximumDepth = 0

  for (const token of tokens) {
    if (token.kind === 'minus' || isKeyword(token, 'NOT')) {
      unaryDepth += 1
    } else if (token.kind === 'lparen') {
      groups.push(unaryDepth + 1)
      depth += unaryDepth + 1
      unaryDepth = 0
    } else if (token.kind === 'rparen') {
      depth -= groups.pop() ?? 0
      unaryDepth = 0
    } else {
      unaryDepth = 0
    }

    maximumDepth = Math.max(maximumDepth, depth + unaryDepth)
  }

  if (text.length > 32768 || tokens.length > 4096 || maximumDepth > 100) {
    return {
      text,
      tokens,
      roles: tokens.map(() => 'unexpected'),
      terms: [],
      node: undefined,
      diagnostics: [
        {
          start: 0,
          end: text.length,
          severity: 'error',
          message: 'Query exceeds the editor limits (32 KB, 4096 tokens, or 100 nested conditions)',
        },
      ],
    }
  }

  const roles: TokenRole[] = tokens.map(() => 'unexpected')
  const terms: QueryTermSpan[] = []
  const diagnostics: QueryDiagnostic[] = []
  let cursor = 0

  const peek = (): QueryToken | undefined => tokens[cursor]

  const report = (
    start: number,
    end: number,
    message: string,
    severity: DiagnosticSeverity = 'error',
  ) => {
    diagnostics.push({ start, end, message, severity })
  }

  const consume = (role: TokenRole): QueryToken | undefined => {
    const token = tokens[cursor]

    if (token) {
      roles[cursor] = role
      cursor += 1
    }

    return token
  }

  // Reads one value word, validates it against its field, and records its role.
  const readOperand = (field: QueryField<T> | undefined, token: QueryToken): Operand => {
    const index = cursor
    const raw = tokenValue(token)
    const check = validateValue(field, raw, today)

    consume(check.role)
    roles[index] = check.role

    if (check.message) report(token.start, token.end, check.message, check.severity)

    const unclosed = token.kind === 'quoted' && !token.closed

    if (unclosed) report(token.start, token.end, 'Close the quote')

    return { raw, end: token.end, invalid: check.severity === 'error' || unclosed }
  }

  const requireOrderedField = (field: QueryField<T> | undefined, token: QueryToken): boolean => {
    if (!field) {
      report(token.start, token.end, `Comparisons need a field, for example count:${token.text}5`)

      return false
    }

    if (field.type !== 'number' && field.type !== 'date') {
      report(
        token.start,
        token.end,
        `${field.key} is not a number or date, so ${token.text} does not apply`,
      )

      return false
    }

    return true
  }

  const parseComparison = (field: QueryField<T> | undefined, token: QueryToken): ParsedValue => {
    const operator = toCompareOperator(token.text)

    consume('compare')

    const applicable = requireOrderedField(field, token)
    const operand = peek()

    if (!operator || !isLiteral(operand) || operand.start !== token.end) {
      report(token.start, token.end, `Add a number or date after ${token.text}`)

      return { value: undefined, end: token.end, invalid: true }
    }

    const read = readOperand(field, operand)

    return {
      value: { kind: 'compare', operator, raw: read.raw },
      end: read.end,
      invalid: read.invalid || !applicable,
    }
  }

  const parseRange = (field: QueryField<T> | undefined, open: QueryToken): ParsedValue => {
    consume('bracket')

    const applicable = requireOrderedField(field, open)

    const fail = (message: string, end: number): ParsedValue => {
      report(open.start, end, message)

      return { value: undefined, end, invalid: true }
    }

    const fromToken = peek()

    if (!isLiteral(fromToken) || fromToken.text === 'TO')
      return fail('Use [start TO end]', open.end)

    const from = readOperand(field, fromToken)

    if (!isLiteral(peek()) || peek()?.text !== 'TO')
      return fail('Put TO between the two values', from.end)

    consume('range-to')

    const toToken = peek()

    if (!isLiteral(toToken)) return fail('Add the end of the range', from.end)

    const to = readOperand(field, toToken)
    const close = peek()

    if (close?.kind === 'rbracket') {
      consume('bracket')
    } else {
      report(open.start, open.end, 'Missing closing ]')
    }

    return {
      value: { kind: 'range', from: from.raw, to: to.raw },
      end: close?.kind === 'rbracket' ? close.end : to.end,
      invalid: from.invalid || to.invalid || !applicable || close?.kind !== 'rbracket',
    }
  }

  const parseValue = (field: QueryField<T> | undefined, fallbackEnd: number): ParsedValue => {
    const token = peek()

    if (!token) return { value: undefined, end: fallbackEnd, invalid: true }

    if (token.kind === 'compare') return parseComparison(field, token)

    if (token.kind === 'lbracket') return parseRange(field, token)

    if (isLiteral(token)) {
      const read = readOperand(field, token)

      return { value: { kind: 'term', raw: read.raw }, end: read.end, invalid: read.invalid }
    }

    return { value: undefined, end: fallbackEnd, invalid: true }
  }

  const startsValue = (token: QueryToken | undefined): boolean =>
    isLiteral(token) || token?.kind === 'compare' || token?.kind === 'lbracket'

  // `field:(a OR b)`: one term that matches any of its values.
  const parseValueList = (
    field: QueryField<T> | undefined,
    open: QueryToken,
    values: QueryValue[],
  ): ParsedValue => {
    consume('paren')

    let end = open.end
    let invalid = false

    while (startsValue(peek())) {
      const parsed = parseValue(field, end)

      if (parsed.value) values.push(parsed.value)

      end = parsed.end
      invalid = invalid || parsed.invalid

      const separator = peek()

      if (separator && isKeyword(separator, 'OR')) {
        consume('operator')

        if (!startsValue(peek())) {
          report(separator.start, separator.end, 'Add a value after OR')
          invalid = true
        }
      } else if (separator && startsValue(separator)) {
        report(separator.start, separator.end, 'Separate values with OR', 'warning')
      }
    }

    const close = peek()

    if (close?.kind === 'rparen') {
      consume('paren')

      if (values.length === 0) {
        report(open.start, close.end, 'Add a value')
        invalid = true
      }

      return { value: undefined, end: close.end, invalid }
    }

    report(open.start, open.end, values.length === 0 ? 'Add a value' : 'Missing closing )')

    return { value: undefined, end, invalid: true }
  }

  const parseFieldTerm = (): QueryNode => {
    const fieldIndex = cursor
    const fieldToken = consume('field')
    const colon = peek()

    if (!fieldToken) return { type: 'term', field: undefined, values: [] }

    if (colon?.kind === 'colon') consume('colon')

    const field = findQueryField(fields, fieldToken.text)
    const termStart = fieldToken.start
    const afterColon = colon?.kind === 'colon' ? colon.end : fieldToken.end
    const values: QueryValue[] = []
    let invalid = !field
    let end = afterColon

    if (field) {
      roles[fieldIndex] = 'field'
    } else {
      roles[fieldIndex] = 'field-unknown'

      const suggestion = closestFieldKey(fields, fieldToken.text)

      report(
        fieldToken.start,
        fieldToken.end,
        suggestion
          ? `Unknown field "${fieldToken.text}". Did you mean ${suggestion}?`
          : `Unknown field "${fieldToken.text}"`,
      )
    }

    const next = peek()
    // A value has to touch its colon: `wot: Air` leaves the field without one.
    const touching = next !== undefined && next.start === afterColon

    if (!touching || !(startsValue(next) || next?.kind === 'lparen')) {
      report(termStart, afterColon, `Add a value after ${fieldToken.text}:`)
      invalid = true
    } else if (next.kind === 'lparen') {
      const parsed = parseValueList(field, next, values)

      end = parsed.end
      invalid = invalid || parsed.invalid
    } else {
      const parsed = parseValue(field, afterColon)

      if (parsed.value) values.push(parsed.value)

      end = parsed.end
      invalid = invalid || parsed.invalid
    }

    terms.push({ start: termStart, end, negated: false, invalid })

    return { type: 'term', field: fieldToken.text.toLowerCase(), values }
  }

  const parseFreeText = (): QueryNode | undefined => {
    const token = peek()

    if (!token) return undefined

    if (token.kind === 'compare') {
      consume('unexpected')
      report(token.start, token.end, `Comparisons need a field, for example pieces:${token.text}5`)

      if (isLiteral(peek()) && peek()?.start === token.end) consume('unexpected')

      return undefined
    }

    const read = readOperand(undefined, token)

    terms.push({ start: token.start, end: read.end, negated: false, invalid: read.invalid })

    return { type: 'term', field: undefined, values: [{ kind: 'term', raw: read.raw }] }
  }

  const parseUnary = (): QueryNode | undefined => {
    const token = peek()

    if (!token) return undefined

    if (token.kind === 'minus' || isKeyword(token, 'NOT')) {
      consume(token.kind === 'minus' ? 'negation' : 'operator')

      const operand = peek()
      const termsBefore = terms.length
      const node = parseUnary()

      if (!node) {
        report(token.start, token.end, `Add a condition after ${token.text}`)

        return undefined
      }

      const span = terms[termsBefore]

      // `-wot:Air` is one chip; `NOT wot:Air` keeps the keyword outside it.
      if (span && node.type === 'term' && span.start === operand?.start) {
        terms[termsBefore] = {
          ...span,
          negated: true,
          start: token.kind === 'minus' ? token.start : span.start,
        }
      }

      return { type: 'not', node }
    }

    if (token.kind === 'lparen') {
      consume('paren')

      const inner = parseOr()
      const close = peek()

      if (close?.kind === 'rparen') {
        consume('paren')
      } else {
        report(token.start, token.end, 'Missing closing )')
      }

      if (!inner && close?.kind === 'rparen') report(token.start, close.end, 'Empty group')

      return inner
    }

    if (token.kind === 'field') return parseFieldTerm()

    if (token.kind === 'text' || token.kind === 'quoted' || token.kind === 'compare')
      return parseFreeText()

    return undefined
  }

  const parseAnd = (): QueryNode | undefined => {
    const children: QueryNode[] = []
    const first = parseUnary()

    if (first) children.push(first)

    for (;;) {
      const token = peek()

      if (token && isKeyword(token, 'AND')) {
        consume('operator')

        if (children.length === 0) report(token.start, token.end, 'Add a condition before AND')

        const next = parseUnary()

        if (next) {
          children.push(next)
        } else {
          report(token.start, token.end, 'Add a condition after AND')
        }
      } else if (startsUnary(token)) {
        const next = parseUnary()

        if (next) children.push(next)
      } else {
        break
      }
    }

    return combine('and', children)
  }

  const parseOr = (): QueryNode | undefined => {
    const children: QueryNode[] = []
    const first = parseAnd()

    if (first) children.push(first)

    for (;;) {
      const token = peek()

      if (!token || !isKeyword(token, 'OR')) break

      consume('operator')

      if (children.length === 0) report(token.start, token.end, 'Add a condition before OR')

      const next = parseAnd()

      if (next) {
        children.push(next)
      } else {
        report(token.start, token.end, 'Add a condition after OR')
      }
    }

    return combine('or', children)
  }

  const roots: QueryNode[] = []

  while (cursor < tokens.length) {
    const before = cursor
    const node = parseOr()

    if (node) roots.push(node)

    const stray = tokens[cursor]

    // No progress means a token no rule accepts here (`)`, a leading `:` …). Flag it and move on.
    if (cursor === before && stray) {
      report(stray.start, stray.end, unexpectedMessage(stray))
      cursor += 1
    }
  }

  return { text, tokens, roles, terms, diagnostics, node: combine('and', roots) }
}

export function hasErrors(parsed: ParsedQuery): boolean {
  return parsed.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
}
