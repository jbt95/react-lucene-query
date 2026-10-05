import { closestFieldKey, type QueryField } from './fields'
import { validateRegex } from './regexp'
import { tokenize, tokenValue } from './tokenizer'
import type {
  ParsedQuery,
  QueryClause,
  QueryDiagnostic,
  QueryNode,
  QueryTermSpan,
  QueryToken,
  QueryValue,
  TokenRole,
} from './types'

const NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

function isNot(token: QueryToken | undefined): boolean {
  return (
    token?.kind === 'minus' ||
    (token?.kind === 'operator' && (token.text === 'NOT' || token.text === '!'))
  )
}

function isPrefix(token: QueryToken | undefined): boolean {
  return token?.kind === 'plus' || isNot(token)
}

function startsClause(token: QueryToken | undefined): boolean {
  return (
    token !== undefined &&
    (isPrefix(token) ||
      ['field', 'text', 'quoted', 'regex', 'lparen', 'lbracket', 'lbrace'].includes(token.kind))
  )
}

function hasWildcard(source: string): boolean {
  for (let index = 0; index < source.length; index += 1) {
    if (source.charAt(index) === '\\') index += source.charAt(index + 1) === 'u' ? 5 : 1
    else if (source.charAt(index) === '*' || source.charAt(index) === '?') return true
  }

  return false
}

function escapeError(source: string): string | undefined {
  for (let index = 0; index < source.length; index += 1) {
    if (source.charAt(index) !== '\\') continue
    index += 1

    if (index === source.length) return 'Add a character after the escape'

    if (source.charAt(index) === 'u') {
      if (!/^[\da-fA-F]{4}$/.test(source.slice(index + 1, index + 5)))
        return 'Use four hexadecimal digits after \\u'
      index += 4
    }
  }

  return undefined
}

function exceedsDepth(tokens: readonly QueryToken[]): boolean {
  const groups: number[] = []
  let depth = 0
  let prefixes = 0

  for (const token of tokens) {
    if (isPrefix(token)) prefixes += 1
    else if (token.kind === 'lparen') {
      groups.push(prefixes + 1)
      depth += prefixes + 1
      prefixes = 0
    } else {
      if (token.kind === 'rparen') depth -= groups.pop() ?? 0
      prefixes = 0
    }

    if (depth + prefixes > 100) return true
  }

  return false
}

/** What to do with a field name no schema declares, where Lucene itself stays permissive. */
export type UnknownFieldMode = 'ignore' | 'suggest' | 'error'

export type ParseOptions = {
  /**
   * Unknown fields match no records. `suggest` adds a "did you mean" warning, which keeps the
   * query valid; `error` rejects it. Defaults to `suggest`, because a silent zero-row search is
   * the most common way a filter query goes wrong.
   */
  readonly unknownFields?: UnknownFieldMode
}

class LuceneParser<T> {
  private prefixModified = false

  readonly roles: TokenRole[]
  readonly terms: QueryTermSpan[] = []
  readonly diagnostics: QueryDiagnostic[] = []
  private cursor = 0

  constructor(
    private readonly tokens: readonly QueryToken[],
    private readonly fields: readonly QueryField<T>[],
    private readonly unknownFields: UnknownFieldMode,
  ) {
    this.roles = tokens.map(() => 'unexpected')
  }

  private peek(): QueryToken | undefined {
    return this.tokens[this.cursor]
  }

  private consume(role: TokenRole): QueryToken | undefined {
    const token = this.peek()

    if (token) {
      this.roles[this.cursor] = role
      this.cursor += 1
    }

    return token
  }

  private report(token: QueryToken, message: string): void {
    this.diagnostics.push({ start: token.start, end: token.end, severity: 'error', message })
  }

  /** An unconfigured field is legal Lucene, but a typo then looks like an empty result set. */
  private reportUnknownField(token: QueryToken, field: string): void {
    if (this.unknownFields === 'ignore') return

    const closest = closestFieldKey(this.fields, field)
    const suggestion = closest === undefined ? '' : ` Did you mean '${closest}'?`
    const message = `No field named '${field}' in this schema.${suggestion}`

    this.diagnostics.push({
      start: token.start,
      end: token.end,
      severity: this.unknownFields === 'error' ? 'error' : 'warning',
      message,
    })
  }

  /** One prefix per clause: `+` requires, and `-`, `!`, `NOT` prohibit. */
  private readPrefix(): QueryClause['occur'] | undefined {
    const token = this.peek()

    if (!isPrefix(token) || !token) return undefined
    this.consume(token.kind === 'plus' ? 'modifier' : 'negation')

    if (this.prefixModified) this.report(token, 'Use only one prefix modifier for a condition')
    this.prefixModified = true

    return token.kind === 'plus' ? 'must' : 'must-not'
  }

  private validateEscapes(token: QueryToken): void {
    const source =
      token.kind === 'quoted'
        ? token.closed
          ? token.text.slice(1, -1)
          : token.text.slice(1)
        : token.text

    const message = token.kind === 'regex' ? undefined : escapeError(source)

    if (message) this.report(token, message)

    if ((token.kind === 'quoted' || token.kind === 'regex') && !token.closed) {
      this.report(
        token,
        token.kind === 'quoted' ? 'Close the quote' : 'Close the regular expression with /',
      )
    }
  }

  private readNumber(modifier: QueryToken, required: boolean): number | undefined {
    const token = this.peek()

    if (!token || token.kind !== 'text' || token.start !== modifier.end) {
      if (required) this.report(modifier, `Add a number after ${modifier.text}`)

      return undefined
    }

    this.consume('modifier')

    if (!NUMBER.test(token.text) || !Number.isFinite(Number(token.text))) {
      this.report(token, 'Use a finite nonnegative number for the modifier')

      return undefined
    }

    return Number(token.text)
  }

  private readBoost(node: QueryNode): QueryNode {
    const token = this.peek()

    if (token?.kind !== 'caret') return node
    this.consume('modifier')
    const boost = this.readNumber(token, true)

    if (boost !== undefined && boost <= 0) this.report(token, 'Boost must be positive')

    return boost !== undefined && boost > 0 ? { ...node, boost } : node
  }

  private readBound(): { raw: string | undefined; token: QueryToken } | undefined {
    const token = this.peek()

    if (!token || (token.kind !== 'text' && token.kind !== 'quoted')) return undefined
    this.consume('value-text')
    this.validateEscapes(token)

    return {
      raw: token.kind === 'text' && token.text === '*' ? undefined : tokenValue(token),
      token,
    }
  }

  private readRange(): QueryValue | undefined {
    const open = this.consume('bracket')

    if (!open) return undefined
    const lower = this.readBound()
    const separator = this.peek()

    if (!lower || separator?.kind !== 'text' || separator.text !== 'TO') {
      this.report(open, 'Use a range with two bounds separated by TO')

      return undefined
    }

    this.consume('range-to')
    const upper = this.readBound()
    const close = this.peek()

    if (!upper || (close?.kind !== 'rbracket' && close?.kind !== 'rbrace')) {
      this.report(open, 'Add the upper bound and close the range with ] or }')

      return undefined
    }

    this.consume('bracket')

    return {
      kind: 'range',
      from: lower.raw,
      to: upper.raw,
      includeLower: open.kind === 'lbracket',
      includeUpper: close.kind === 'rbracket',
    }
  }

  private readValue(field: string | undefined): QueryValue | undefined {
    const token = this.peek()

    if (!token) return undefined

    if (token.kind === 'lbracket' || token.kind === 'lbrace') return this.readRange()

    if (token.kind !== 'text' && token.kind !== 'quoted' && token.kind !== 'regex') return undefined

    this.validateEscapes(token)

    const wildcard = token.kind === 'text' && hasWildcard(token.text)

    this.consume(this.readValueRole(token, wildcard, field))

    const value = this.buildValue(token, wildcard)
    const modifier = this.peek()

    if (modifier?.kind !== 'tilde') return value

    this.consume('modifier')

    return this.readModifier(value, modifier)
  }

  private readValueRole(
    token: QueryToken,
    wildcard: boolean,
    field: string | undefined,
  ): TokenRole {
    if (token.kind === 'regex') return 'regex'

    if (wildcard) return 'wildcard'

    return field === undefined ? 'free-text' : 'value-text'
  }

  private buildValue(token: QueryToken, wildcard: boolean): QueryValue {
    const raw = tokenValue(token)

    if (token.kind === 'regex') {
      const error = token.closed ? validateRegex(raw) : undefined

      if (error) this.report(token, error)

      return { kind: 'regex', raw }
    }

    if (token.kind === 'quoted') return { kind: 'phrase', raw }

    if (token.text === '&' || token.text === '|') {
      this.report(token, 'Escape a literal & or |, or use && or ||')
    }

    return wildcard ? { kind: 'wildcard', raw: token.text } : { kind: 'term', raw }
  }

  /** A tilde is proximity after a phrase and an edit distance after a bare term. */
  private readModifier(value: QueryValue, modifier: QueryToken): QueryValue {
    if (value.kind === 'phrase') {
      const proximity = this.readNumber(modifier, true)

      if (proximity !== undefined && !Number.isSafeInteger(proximity)) {
        this.report(modifier, 'Phrase proximity must be a nonnegative integer')
      }

      return proximity === undefined ? value : { ...value, proximity }
    }

    if (value.kind === 'term') {
      const distance = this.readNumber(modifier, false)

      if (
        distance !== undefined &&
        distance >= 1 &&
        (!Number.isInteger(distance) || distance > 2)
      ) {
        this.report(
          modifier,
          'Fuzzy distance must be a similarity below one or an edit distance from zero to two',
        )
      }

      // An absent number keeps the default distance of two edits.
      return distance === undefined
        ? { kind: 'fuzzy', raw: value.raw }
        : { kind: 'fuzzy', raw: value.raw, distance }
    }

    this.report(modifier, 'Fuzzy modifiers apply only to terms; proximity applies only to phrases')
    this.readNumber(modifier, false)

    return value
  }

  private readAtom(scope: string | undefined): QueryNode | undefined {
    const token = this.peek()

    if (!token) return undefined

    if (token.kind === 'lparen') {
      this.consume('paren')
      const node = this.readBoolean(scope)
      const close = this.peek()

      if (close?.kind === 'rparen') this.consume('paren')
      else this.report(token, 'Close the group with )')

      if (!node) this.report(token, 'Add a condition inside the group')

      return node?.type === 'term'
        ? { type: 'boolean', clauses: [{ occur: 'should', node }] }
        : node
    }

    const value = this.readValue(scope)

    return value ? { type: 'term', field: scope, value } : undefined
  }

  private readClause(scope: string | undefined): QueryClause | undefined {
    const start = this.peek()

    if (!start) return undefined
    const errorsBefore = this.diagnostics.length
    const termsBefore = this.terms.length
    this.prefixModified = false
    let occur = this.readPrefix() ?? 'should'
    let field = scope
    const fieldToken = this.peek()

    if (fieldToken?.kind === 'field') {
      this.validateEscapes(fieldToken)
      field = tokenValue(fieldToken)

      const known = this.fields.some((candidate) => candidate.key === field) || field === '*'

      if (!known) this.reportUnknownField(fieldToken, field)
      this.consume(known ? 'field' : 'field-unknown')
      this.consume('colon')

      occur = this.readPrefix() ?? occur
    }

    if (isPrefix(this.peek())) {
      const token = this.peek()

      if (token) this.report(token, 'Use only one prefix modifier for a condition')

      while (isPrefix(this.peek())) this.consume('unexpected')
    }

    let node = this.readAtom(field)

    if (!node) {
      this.report(start, 'Add a condition after the field or prefix')

      return undefined
    }

    node = this.readBoost(node)
    const end = this.tokens[this.cursor - 1]?.end ?? start.end

    if (node.type === 'term') {
      this.terms.push({
        start: start.start,
        end,
        negated: occur === 'must-not',
        invalid: errorsBefore !== this.diagnostics.length,
      })
    } else if (occur === 'must-not') {
      for (let index = termsBefore; index < this.terms.length; index += 1) {
        const span = this.terms[index]

        if (span) this.terms[index] = { ...span, negated: true }
      }
    }

    return { occur, node }
  }

  /** Explicit AND turns both neighbours into required clauses, never a prohibited one. */
  private promoteToMust(clauses: QueryClause[], clause: QueryClause): void {
    const previous = clauses.at(-1)

    if (previous && previous.occur !== 'must-not')
      clauses[clauses.length - 1] = { ...previous, occur: 'must' }

    if (clause.occur !== 'must-not') clauses.push({ ...clause, occur: 'must' })
    else clauses.push(clause)
  }

  private readBoolean(scope: string | undefined): QueryNode | undefined {
    const clauses: QueryClause[] = []
    const first = this.readClause(scope)

    if (first) clauses.push(first)

    for (;;) {
      const token = this.peek()

      if (!token || token.kind === 'rparen') break

      const conjunction =
        token.kind === 'operator' && ['AND', 'OR', '&&', '||'].includes(token.text)

      if (!conjunction && !startsClause(token)) break

      if (conjunction) this.consume('operator')
      const clause = this.readClause(scope)

      if (!clause) {
        this.report(token, `Add a condition after ${token.text}`)
        break
      }

      if (conjunction && (token.text === 'AND' || token.text === '&&')) {
        this.promoteToMust(clauses, clause)
      } else clauses.push(clause)
    }

    if (clauses.length === 0) return undefined

    const only = clauses[0]

    if (clauses.length === 1 && only?.occur === 'should') return only.node

    return { type: 'boolean', clauses }
  }

  parse(): QueryNode | undefined {
    const node = this.readBoolean(undefined)

    while (this.cursor < this.tokens.length) {
      const token = this.consume('unexpected')

      if (token) this.report(token, `Unexpected ${token.text}`)
    }

    return node
  }
}

export function parseQuery<T>(
  text: string,
  fields: readonly QueryField<T>[] = [],
  options: ParseOptions = {},
): ParsedQuery {
  const tokens = text.length > 32768 ? [] : tokenize(text)

  if (text.length > 32768 || tokens.length > 4096 || exceedsDepth(tokens)) {
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

  if (!tokens.length)
    return { text, tokens, roles: [], terms: [], diagnostics: [], node: undefined }
  const parser = new LuceneParser(tokens, fields, options.unknownFields ?? 'suggest')
  const node = parser.parse()

  return {
    text,
    tokens,
    node,
    roles: parser.roles,
    terms: parser.terms,
    diagnostics: parser.diagnostics,
  }
}

export function hasErrors(parsed: ParsedQuery): boolean {
  return parsed.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
}
