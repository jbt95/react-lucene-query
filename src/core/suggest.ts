import { Match, Option } from 'effect'
import { escapeTerm } from './build'
import { scalarText } from './evaluate'
import { fieldValues, findQueryField, type QueryField } from './fields'
import { tokenize, tokenValue } from './tokenizer'
import type { QueryToken, TokenRole } from './types'

export type SuggestionKind = 'field' | 'value' | 'operator'

export type Suggestion = {
  readonly id: string
  readonly kind: SuggestionKind
  readonly label: string
  // Replaces the text between `from` and `to`, trailing space included where one belongs.
  readonly insert: string
  readonly detail?: string
  readonly tag?: string
  readonly count?: number
  readonly matchLength: number
  readonly role: TokenRole
  readonly keepOpen?: boolean
}

export type SuggestionList = {
  readonly from: number
  readonly to: number
  readonly title: string
  readonly items: readonly Suggestion[]
  readonly autoSelect: boolean
}

export interface SuggestionOptions<T> {
  readonly limit?: number
  readonly getValues?: (field: QueryField<T>) => ReadonlyMap<string, number>
}

export function applySuggestion(text: string, list: SuggestionList, item: Suggestion) {
  return {
    value: text.slice(0, list.from) + item.insert + text.slice(list.to),
    caret: list.from + item.insert.length,
  }
}

const MAX_VALUE_SUGGESTIONS = 8

type Slot = {
  readonly from: number
  readonly to: number
  readonly prefix: string
  readonly token: QueryToken | undefined
  readonly previous: QueryToken | undefined
  readonly previousIndex: number
}

function findSlot(tokens: readonly QueryToken[], caret: number): Slot | undefined {
  const index = tokens.findIndex((token) => token.start < caret && caret <= token.end)
  const token = tokens[index]

  if (token?.kind === 'regex' && (token.closed !== true || caret < token.end)) return undefined

  const typing =
    token !== undefined &&
    (token.kind === 'text' ||
      token.kind === 'field' ||
      (token.kind === 'quoted' && !(token.closed && caret === token.end)))

  if (typing) {
    const source = token.text.slice(0, caret - token.start)

    // A dangling escape or incomplete Unicode escape has no decoded prefix yet.
    if (/(?:^|[^\\])(?:\\\\)*\\(?:u[\da-fA-F]{0,3})?$/.test(source)) return undefined

    return {
      from: token.start,
      to: token.end,
      prefix: tokenValue({ ...token, text: source, closed: false }),
      token,
      previous: tokens[index - 1],
      previousIndex: index - 1,
    }
  }

  // Do not insert in the middle of punctuation or a completed operator token.
  if (token && caret < token.end) return undefined

  let previousIndex = -1

  for (const [candidateIndex, candidate] of tokens.entries()) {
    if (candidate.end <= caret) previousIndex = candidateIndex
  }

  return {
    from: caret,
    to: caret,
    prefix: '',
    token: undefined,
    previous: tokens[previousIndex],
    previousIndex,
  }
}

type Group = {
  readonly field: string | undefined
  expectOperand: boolean
  unary: boolean
}

type CursorContext = {
  readonly field: string | undefined
  readonly explicitValue: boolean
  readonly afterOperand: boolean
}

// Only inspect the prefix. Suffix text must not change the inherited field at the caret.
// Each method returns false when the prefix is not a position where completion can be offered.
class CursorScanner {
  private group: Group = { field: undefined, expectOperand: true, unary: false }
  private readonly parents: Group[] = []
  private explicitField: string | undefined
  private awaitingColon = false
  private range: QueryToken[] | undefined
  private modifier: 'tilde' | 'caret' | undefined
  private modified: 'tilde' | 'caret' | undefined

  /**
   * One exhaustive map over the token kinds, built once per scan instead of once per token. A new
   * kind has no way to reach this file unnoticed: the handler map is missing a case, and the call
   * stops compiling.
   */
  private readonly readToken: (token: QueryToken) => boolean

  constructor() {
    this.readToken = Match.type<QueryToken>().pipe(
      Match.discriminatorsExhaustive('kind')({
        field: (token) => this.readField(token),
        colon: () => this.readColon(),
        lparen: () => this.openGroup(),
        rparen: () => this.closeGroup(),
        lbracket: () => this.openRange(),
        lbrace: () => this.openRange(),
        rbracket: () => false,
        rbrace: () => false,
        operator: (token) => this.readOperator(token),
        plus: () => this.readPrefix(),
        minus: () => this.readPrefix(),
        tilde: (token) => this.readModifierToken(token),
        caret: (token) => this.readModifierToken(token),
        text: (token) => this.readOperand(token),
        quoted: (token) => this.readOperand(token),
        regex: (token) => this.readOperand(token),
      }),
    )
  }

  /** A range collects its bounds until the closing bracket, which must be well formed. */
  private openRange(): boolean {
    this.range = []

    return true
  }

  scan(tokens: readonly QueryToken[], slot: Slot): CursorContext | undefined {
    for (let index = 0; index <= slot.previousIndex; index += 1) {
      const token = tokens[index]

      if (!token) continue

      if (this.range) {
        if (!this.readRangeBound(token)) return undefined

        continue
      }

      if (this.awaitingColon && token.kind !== 'colon') return undefined

      if (this.modifier && this.readModifierNumber(token)) continue

      if (!this.readToken(token)) return undefined
    }

    if (this.range || this.awaitingColon || this.modifier) return undefined

    return {
      field: this.explicitField ?? this.group.field,
      explicitValue: this.explicitField !== undefined,
      afterOperand: !this.group.expectOperand,
    }
  }

  /** A range collects its bounds until the closing bracket, which must be well formed. */
  private readRangeBound(token: QueryToken): boolean {
    if (token.kind !== 'rbracket' && token.kind !== 'rbrace') {
      this.range?.push(token)

      return true
    }

    const range = this.range

    this.range = undefined

    if (!range) return false

    const [lower, separator, upper] = range

    if (
      range.length !== 3 ||
      (lower?.kind !== 'text' && lower?.kind !== 'quoted') ||
      (upper?.kind !== 'text' && upper?.kind !== 'quoted') ||
      separator?.text !== 'TO'
    )
      return false

    this.group.expectOperand = false
    this.group.unary = false
    this.explicitField = undefined
    this.modified = undefined

    return true
  }

  /** A modifier consumes the following number; a bare tilde may also end before a connective. */
  private readModifierNumber(token: QueryToken): boolean {
    if (token.kind !== 'text' || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(token.text)) {
      if (this.modifier !== 'tilde') return false
    } else {
      this.modifier = undefined

      return true
    }

    this.modifier = undefined

    return false
  }

  private readField(token: QueryToken): boolean {
    if (this.explicitField !== undefined) return false
    this.explicitField = tokenValue(token)
    this.awaitingColon = true
    this.group.expectOperand = true

    return true
  }

  private readColon(): boolean {
    if (!this.awaitingColon) return false
    this.awaitingColon = false

    return true
  }

  private openGroup(): boolean {
    this.parents.push(this.group)
    this.group = {
      field: this.explicitField ?? this.group.field,
      expectOperand: true,
      unary: false,
    }
    this.explicitField = undefined
    this.modified = undefined

    return true
  }

  private closeGroup(): boolean {
    if (this.group.expectOperand || this.explicitField !== undefined) return false

    const parent = this.parents.pop()

    if (!parent) return false
    this.group = parent
    this.group.expectOperand = false
    this.group.unary = false
    this.modified = undefined

    return true
  }

  private readOperator(token: QueryToken): boolean {
    const negation = token.text === 'NOT' || token.text === '!'

    if (negation ? this.group.unary : this.group.expectOperand) return false

    if (this.explicitField !== undefined) return false
    this.group.expectOperand = true
    this.group.unary = negation

    return true
  }

  private readPrefix(): boolean {
    if (this.group.unary || this.explicitField !== undefined) return false
    this.group.expectOperand = true
    this.group.unary = true

    return true
  }

  private readModifierToken(token: QueryToken): boolean {
    const kind = token.kind === 'tilde' ? 'tilde' : 'caret'

    if (this.group.expectOperand || this.modified === 'caret' || this.modified === kind)
      return false
    this.modifier = kind
    this.modified = kind

    return true
  }

  private readOperand(token: QueryToken): boolean {
    if ((token.kind === 'quoted' || token.kind === 'regex') && token.closed !== true) return false
    this.group.expectOperand = false
    this.group.unary = false
    this.explicitField = undefined
    this.modified = undefined

    return true
  }
}

function cursorContext(tokens: readonly QueryToken[], slot: Slot): Option.Option<CursorContext> {
  return Option.fromUndefinedOr(new CursorScanner().scan(tokens, slot))
}

function matchLength(label: string, prefix: string): number {
  return prefix !== '' && label.toLowerCase().startsWith(prefix.toLowerCase()) ? prefix.length : 0
}

function countValues<T>(field: QueryField<T>, records: readonly T[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()

  for (const record of records) {
    // A multi-valued field contributes every entry, so `tags:design` suggests and matches.
    for (const value of fieldValues(field, record)) {
      const text = scalarText(value)

      if (text === undefined) continue
      counts.set(text, (counts.get(text) ?? 0) + 1)
    }
  }

  return counts
}

function sortedCandidates<T>(field: QueryField<T>, counts: ReadonlyMap<string, number>): string[] {
  if (field.options) return [...field.options]
  const values = [...counts.keys()]

  // eslint-disable-next-line unicorn/no-array-sort -- sorting a copy this function just built
  return values.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b))
}

function template(label: string, detail: string, role: TokenRole): Suggestion {
  return {
    id: `template:${label}`,
    kind: 'value',
    label,
    insert: label,
    detail,
    matchLength: 0,
    role,
    keepOpen: true,
  }
}

const VALUE_TEMPLATES: readonly Suggestion[] = [
  template('[* TO *]', 'Inclusive lexical range; replace either bound', 'bracket'),
  template('{* TO *}', 'Exclusive lexical range; replace either bound', 'bracket'),
  template('*', 'Match any term', 'wildcard'),
  template('/.*/', 'Lucene regular expression', 'regex'),
]

function valueSuggestions<T>(
  field: QueryField<T>,
  slot: Slot,
  text: string,
  records: readonly T[],
  options: SuggestionOptions<T>,
): Option.Option<SuggestionList> {
  const counts = options.getValues?.(field) ?? countValues(field, records)
  const { prefix } = slot
  const following = text.charAt(slot.to)
  const trailing = following === '' ? ' ' : ''

  const matching = sortedCandidates(field, counts).filter((candidate) =>
    candidate.toLowerCase().startsWith(prefix.toLowerCase()),
  )

  const limit = options.limit ?? MAX_VALUE_SUGGESTIONS

  const values = matching.slice(0, Math.max(0, limit)).map(
    (candidate) =>
      ({
        id: `value:${candidate}`,
        kind: 'value',
        label: candidate,
        insert: `${escapeTerm(candidate)}${trailing}`,
        count: counts.get(candidate) ?? 0,
        matchLength: matchLength(candidate, prefix),
        role: 'value-text',
      }) satisfies Suggestion,
  )

  const items = [...(prefix === '' ? VALUE_TEMPLATES : []), ...values]

  if (items.length === 0) return Option.none()
  const [only] = items

  if (items.length === 1 && only && prefix !== '' && only.label === prefix) return Option.none()

  return Option.some({
    from: slot.from,
    to: slot.to,
    title: `${field.label} · ${field.key}`,
    items,
    autoSelect: prefix !== '',
  })
}

type KeywordHint = { readonly word: string; readonly detail: string }

const AND_OR_HINTS: readonly KeywordHint[] = [
  { word: 'AND', detail: 'Require both conditions' },
  { word: 'OR', detail: 'Allow either condition' },
]

const NOT_HINT: KeywordHint = { word: 'NOT', detail: 'Exclude what matches next' }

function fieldRank<T>(field: QueryField<T>, prefix: string): number {
  if (prefix === '') return 0
  const needle = prefix.toLowerCase()
  const label = field.label.toLowerCase()

  if (field.key.toLowerCase().startsWith(needle)) return 0

  if (label.split(/[\s(]+/).some((word) => word.startsWith(needle))) return 1

  if (field.key.toLowerCase().includes(needle)) return 2

  return label.includes(needle) ? 3 : -1
}

function fieldSuggestions<T>(
  fields: readonly QueryField<T>[],
  slot: Slot,
  text: string,
  afterOperand: boolean,
): Option.Option<SuggestionList> {
  const { prefix } = slot

  const negating =
    slot.previous?.kind === 'minus' ||
    slot.previous?.kind === 'plus' ||
    (slot.previous?.kind === 'operator' &&
      (slot.previous.text === 'NOT' || slot.previous.text === '!'))

  const hints = [...(afterOperand ? AND_OR_HINTS : []), ...(negating ? [] : [NOT_HINT])]

  const keywords = hints.flatMap((hint) =>
    prefix === '' || hint.word.startsWith(prefix.toUpperCase())
      ? [
          {
            id: `keyword:${hint.word}`,
            kind: 'operator',
            label: hint.word,
            insert: `${hint.word} `,
            detail: hint.detail,
            matchLength: matchLength(hint.word, prefix),
            role: 'operator',
          } satisfies Suggestion,
        ]
      : [],
  )

  const ranked = fields.flatMap((field) => {
    const rank = fieldRank(field, prefix)

    return rank >= 0 ? [{ field, rank }] : []
  })

  const fieldItems = ranked
    // eslint-disable-next-line unicorn/no-array-sort -- sorting a copy this function just built
    .sort((a, b) => a.rank - b.rank)
    .map(
      ({ field }) =>
        ({
          id: `field:${field.key}`,
          kind: 'field',
          label: field.key,
          // Field names use character escapes, not phrase quotes.
          insert: `${field.key.replace(/[\s+\-!(){}[\]^"~*?:\\/|&]/gu, '\\$&')}:`,
          detail: field.label,
          tag: field.type,
          matchLength: matchLength(field.key, prefix),
          role: 'field',
        }) satisfies Suggestion,
    )

  const items =
    afterOperand && prefix === '' ? [...keywords, ...fieldItems] : [...fieldItems, ...keywords]

  if (items.length === 0) return Option.none()
  const to = text.charAt(slot.to) === ':' ? slot.to + 1 : slot.to

  return Option.some({
    from: slot.from,
    to,
    title: afterOperand && prefix === '' ? 'Operators and fields' : 'Fields',
    items,
    autoSelect: prefix !== '',
  })
}

function attachedSuggestions(token: QueryToken, caret: number): Option.Option<SuggestionList> {
  const items = [template('^2', 'Boost this clause; local filters do not rank', 'modifier')]

  if (token.kind === 'text') {
    items.unshift(
      template('~', 'Fuzzy term', 'modifier'),
      template('*', 'Wildcard suffix', 'wildcard'),
      template('?', 'Single-character wildcard suffix', 'wildcard'),
    )
  } else if (token.kind === 'quoted') {
    items.unshift(template('~2', 'Phrase proximity', 'modifier'))
  } else if (
    token.kind !== 'regex' &&
    token.kind !== 'rparen' &&
    token.kind !== 'rbracket' &&
    token.kind !== 'rbrace'
  ) {
    return Option.none()
  }

  return Option.some({ from: caret, to: caret, title: 'Modifiers', items, autoSelect: false })
}

type ResolvedSlot = {
  readonly slot: Slot
  readonly context: CursorContext
}

/** Budget, caret, and prefix validity are settled before any content decision is made. */
function resolveSlot(
  text: string,
  caret: number,
  tokens: readonly QueryToken[],
): Option.Option<ResolvedSlot> {
  // Every rejection below is "there is nothing to offer here", which is an answer, not a hole.
  if (text.length > 32768 || !Number.isInteger(caret) || caret < 0 || caret > text.length) {
    return Option.none()
  }

  const slot = findSlot(tokens, caret)

  if (!slot) return Option.none()

  // Modifier numbers and anchors are never completed.
  if (slot.previous?.kind === 'tilde' || slot.previous?.kind === 'caret') return Option.none()

  const following = text.charAt(slot.to)

  if (slot.prefix === '' && following !== '' && !/[\s)]/.test(following)) return Option.none()

  return Option.match(cursorContext(tokens, slot), {
    onNone: () => Option.none(),
    onSome: (context) => Option.some({ slot, context }),
  })
}

/** At the end of a finished operand, a partial field name outranks modifier insertion. */
function operandEndSuggestions<T>(
  fields: readonly QueryField<T>[],
  slot: Slot,
  text: string,
  context: CursorContext,
  last: QueryToken,
  caret: number,
): Option.Option<SuggestionList> {
  const fieldsList = fieldSuggestions(fields, slot, text, context.afterOperand)

  return Option.match(fieldsList, {
    onNone: () => attachedSuggestions(last, caret),
    onSome: (list) =>
      slot.token && list.items.some((item) => item.kind === 'field')
        ? Option.some(list)
        : attachedSuggestions(last, caret),
  })
}

// Suggestions never replace text outside the cursor token or reinterpret a literal value.
export function getSuggestions<T>(
  text: string,
  caret: number,
  fields: readonly QueryField<T>[],
  records: readonly T[] = [],
  options: SuggestionOptions<T> = {},
): Option.Option<SuggestionList> {
  const tokens = tokenize(text)

  if (tokens.length > 4096) return Option.none()

  return Option.match(resolveSlot(text, caret, tokens), {
    onNone: () => Option.none(),
    onSome: ({ slot, context }) => {
      if (slot.token?.kind === 'field')
        return fieldSuggestions(fields, slot, text, context.afterOperand)

      return Option.match(Option.fromUndefinedOr(context.field), {
        onNone: () => finishAt(fields, slot, text, context, caret),
        onSome: (key) => {
          const field = findQueryField(fields, key)

          // Unknown fields remain legal, but must never borrow another field's record values.
          if (field === undefined) return Option.none()

          return Option.match(valueSuggestions(field, slot, text, records, options), {
            onNone: () =>
              // An explicit value mid-edit is still being typed: offering anything else here would
              // replace text the user is in the middle of writing.
              context.explicitValue && slot.token?.end !== caret
                ? Option.none()
                : finishAt(fields, slot, text, context, caret),
            onSome: (values) => {
              if (context.explicitValue) return Option.some(values)

              // An inherited field offers its own values first, then the fields it could have been.
              // With no field to add, the values alone are still the answer.
              return Option.match(fieldSuggestions(fields, slot, text, context.afterOperand), {
                onNone: () => Option.some(values),
                onSome: (other) =>
                  Option.some({ ...values, items: [...values.items, ...other.items] }),
              })
            },
          })
        },
      })
    },
  })
}

/** The tail shared by both routes: a finished operand, or a fresh field list. */
function finishAt<T>(
  fields: readonly QueryField<T>[],
  slot: Slot,
  text: string,
  context: CursorContext,
  caret: number,
): Option.Option<SuggestionList> {
  const last = slot.token ?? slot.previous

  if (
    last?.end === caret &&
    (slot.token?.kind === 'text' || (slot.token === undefined && context.afterOperand))
  ) {
    return operandEndSuggestions(fields, slot, text, context, last, caret)
  }

  if (context.explicitValue) return Option.none()

  return fieldSuggestions(fields, slot, text, context.afterOperand)
}
