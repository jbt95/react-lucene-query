import {
  findQueryField,
  type QueryField,
  type QueryFieldType,
  type QueryFieldValue,
} from './query-fields'
import { tokenize, tokenValue } from './query-tokenizer'
import type { QueryToken, TokenRole } from './query-types'

export type SuggestionKind = 'field' | 'value' | 'operator'

export type Suggestion = {
  readonly id: string
  readonly kind: SuggestionKind
  readonly label: string
  // Replaces the text between `from` and `to`, trailing space included where one belongs.
  readonly insert: string
  readonly detail?: string
  // Right-aligned: the field's type for fields, the number of matching records for values.
  readonly tag?: string
  readonly count?: number
  // Characters of `label` the user has already typed, so the list can emphasise them.
  readonly matchLength: number
  readonly role: TokenRole
  // Templates such as `>` or `[a TO b]` are not finished yet; the popover stays open after them.
  readonly keepOpen?: boolean
}

export type SuggestionList = {
  readonly from: number
  readonly to: number
  readonly title: string
  readonly items: readonly Suggestion[]
  // With a typed prefix the best match is pre-selected so Tab or Enter completes it. With none,
  // nothing is selected so Enter still applies the query instead of inserting an operator.
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

const TYPE_TAGS: Record<QueryFieldType, string> = {
  text: 'text',
  number: 'number',
  date: 'date',
  boolean: 'boolean',
  enum: 'list',
}

const TYPE_ROLES: Record<QueryFieldType, TokenRole> = {
  text: 'value-text',
  number: 'value-number',
  date: 'value-date',
  boolean: 'value-boolean',
  enum: 'value-enum',
}

type Slot = {
  readonly from: number
  readonly to: number
  readonly prefix: string
  // The token just before the slot, which decides what may be typed next.
  readonly previous: QueryToken | undefined
  readonly previousIndex: number
}

function findSlot(tokens: readonly QueryToken[], caret: number): Slot | undefined {
  const index = tokens.findIndex((token) => token.start < caret && caret <= token.end)
  const token = tokens[index]

  const typing =
    token !== undefined &&
    (token.kind === 'text' ||
      token.kind === 'field' ||
      (token.kind === 'quoted' && !(token.closed && caret === token.end)))

  if (token && typing) {
    return {
      from: token.start,
      to: token.end,
      prefix: tokenValue({
        ...token,
        text: token.text.slice(0, caret - token.start),
        closed: false,
      }),
      previous: tokens[index - 1],
      previousIndex: index - 1,
    }
  }

  // The caret sits right after a punctuation token, or in whitespace between tokens.
  let previousIndex = -1

  for (const [candidateIndex, candidate] of tokens.entries()) {
    if (candidate.end <= caret) previousIndex = candidateIndex
  }

  return {
    from: caret,
    to: caret,
    prefix: '',
    previous: tokens[previousIndex],
    previousIndex,
  }
}

// If a value may be typed in this slot, which field's value is it?
function fieldForValue<T>(
  fields: readonly QueryField<T>[],
  tokens: readonly QueryToken[],
  slot: Slot,
): QueryField<T> | undefined {
  const { previous, previousIndex } = slot

  if (!previous) return undefined

  const fieldAt = (colonIndex: number): QueryField<T> | undefined => {
    const colon = tokens[colonIndex]
    const name = tokens[colonIndex - 1]

    if (colon?.kind !== 'colon' || name?.kind !== 'field') return undefined

    return findQueryField(fields, name.text)
  }

  switch (previous.kind) {
    case 'colon':
      return previous.end === slot.from ? fieldAt(previousIndex) : undefined
    case 'compare':
      return previous.end === slot.from ? fieldAt(previousIndex - 1) : undefined
    case 'lparen':
      return fieldAt(previousIndex - 1)
    case 'operator': {
      if (previous.text !== 'OR') return undefined

      // `field:(a OR |`: walk back over the list to its opening bracket.
      for (let index = previousIndex - 1; index >= 0; index -= 1) {
        const token = tokens[index]

        if (token?.kind === 'lparen') return fieldAt(index - 1)

        if (token?.kind !== 'text' && token?.kind !== 'quoted' && token?.kind !== 'operator') break
      }

      return undefined
    }

    default:
      return undefined
  }
}

function matchLength(label: string, prefix: string): number {
  return prefix !== '' && label.toLowerCase().startsWith(prefix.toLowerCase()) ? prefix.length : 0
}

function needsQuotes(value: string): boolean {
  return /[\s()[\]":\\]/.test(value) || /^(?:AND|OR|NOT|TO)$/.test(value) || value.startsWith('-')
}

function quote(value: string): string {
  return needsQuotes(value) ? `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : value
}

function toText(value: QueryFieldValue): string | undefined {
  return value === null || value === undefined ? undefined : String(value)
}

function countValues<T>(field: QueryField<T>, records: readonly T[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()

  for (const record of records) {
    const text = toText(field.read(record))

    if (text !== undefined) counts.set(text, (counts.get(text) ?? 0) + 1)
  }

  return counts
}

function sortedCandidates<T>(field: QueryField<T>, counts: ReadonlyMap<string, number>): string[] {
  if (field.type === 'enum') return [...(field.options ?? [])]

  if (field.type === 'boolean') return ['true', 'false']

  const values = [...counts.keys()]

  // eslint-disable-next-line unicorn/no-array-sort -- sorting a copy this function just built
  if (field.type === 'number') return values.sort((a, b) => Number(a) - Number(b))

  // eslint-disable-next-line unicorn/no-array-sort -- sorting a copy this function just built
  if (field.type === 'date') return values.sort()

  // eslint-disable-next-line unicorn/no-array-sort -- sorting a copy this function just built
  return values.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b))
}

function valueTemplates<T>(field: QueryField<T>, prefix: string): Suggestion[] {
  if (prefix !== '' || (field.type !== 'number' && field.type !== 'date')) return []

  const role: TokenRole = 'compare'

  const template = (label: string, detail: string): Suggestion => ({
    id: `template:${label}`,
    kind: 'value',
    label,
    insert: label,
    detail,
    matchLength: 0,
    role,
    keepOpen: true,
  })

  const comparisons = [
    template('>', 'greater than'),
    template('>=', 'at least'),
    template('<', 'less than'),
    template('<=', 'at most'),
  ]

  return field.type === 'date'
    ? [...comparisons, template('[today TO today+7]', 'within the next 7 days')]
    : [...comparisons, template('[100 TO 200]', 'between, both ends included')]
}

function relativeDates(prefix: string, trailing: string): Suggestion[] {
  return ['today', 'today+7', 'today-7'].flatMap((option) =>
    option.startsWith(prefix.toLowerCase())
      ? [
          {
            id: `relative:${option}`,
            kind: 'value',
            label: option,
            insert: `${option}${trailing}`,
            detail: option === 'today' ? 'the current day' : `${option.slice(5)} days`,
            matchLength: matchLength(option, prefix),
            role: 'value-date',
          } satisfies Suggestion,
        ]
      : [],
  )
}

function valueSuggestions<T>(
  field: QueryField<T>,
  slot: Slot,
  text: string,
  records: readonly T[],
  options: SuggestionOptions<T>,
): SuggestionList | undefined {
  const counts = options.getValues?.(field) ?? countValues(field, records)
  const { prefix } = slot
  const inList = slot.previous?.kind === 'lparen' || slot.previous?.kind === 'operator'
  const afterCompare = slot.previous?.kind === 'compare'
  const nextChar = text.charAt(slot.to)
  const trailing = inList || nextChar === ' ' || nextChar === ')' ? '' : ' '
  const role = TYPE_ROLES[field.type]

  const matching = sortedCandidates(field, counts).filter((candidate) =>
    candidate.toLowerCase().startsWith(prefix.toLowerCase()),
  )

  const values = matching.slice(0, options.limit ?? MAX_VALUE_SUGGESTIONS).map(
    (candidate) =>
      ({
        id: `value:${candidate}`,
        kind: 'value',
        label: candidate,
        insert: `${quote(candidate)}${trailing}`,
        count: counts.get(candidate) ?? 0,
        matchLength: matchLength(candidate, prefix),
        role,
      }) satisfies Suggestion,
  )

  const dates = field.type === 'date' ? relativeDates(prefix, trailing) : []
  const templates = afterCompare || inList ? [] : valueTemplates(field, prefix)
  const items = [...templates, ...dates, ...values]

  if (items.length === 0) return undefined

  // Nothing left to complete once the typed text is the only suggestion, so stay out of the way.
  const [only] = items

  if (
    items.length === 1 &&
    only &&
    prefix !== '' &&
    only.label.toLowerCase() === prefix.toLowerCase()
  ) {
    return undefined
  }

  return {
    from: slot.from,
    to: slot.to,
    title: `${field.label} · ${field.key}`,
    items,
    autoSelect: prefix !== '',
  }
}

type KeywordHint = { readonly word: string; readonly detail: string }

const AND_OR_HINTS: readonly KeywordHint[] = [
  { word: 'AND', detail: 'Both conditions must match' },
  { word: 'OR', detail: 'Either condition may match' },
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
  caretAfterOperand: boolean,
): SuggestionList | undefined {
  const { prefix } = slot
  const previousKind = slot.previous?.kind

  const negating =
    previousKind === 'minus' || (slot.previous?.kind === 'operator' && slot.previous.text === 'NOT')

  const hints: KeywordHint[] = [
    ...(caretAfterOperand ? AND_OR_HINTS : []),
    ...(negating ? [] : [NOT_HINT]),
  ]

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
          insert: `${field.key}:`,
          detail: field.label,
          tag: TYPE_TAGS[field.type],
          matchLength: matchLength(field.key, prefix),
          role: 'field',
        }) satisfies Suggestion,
    )

  // After a finished condition the next word is usually a connective; otherwise a field.
  const items =
    caretAfterOperand && prefix === '' ? [...keywords, ...fieldItems] : [...fieldItems, ...keywords]

  if (items.length === 0) return undefined

  // `wo|t:Air` — replace the name only and keep the colon already there.
  const to = slot.to < text.length && text.charAt(slot.to) === ':' ? slot.to + 1 : slot.to

  return {
    from: slot.from,
    to,
    title: caretAfterOperand && prefix === '' ? 'Operators and fields' : 'Fields',
    items,
    autoSelect: prefix !== '',
  }
}

// Suggestions for the word at `caret`, or `undefined` when there is nothing useful to offer.
export function getSuggestions<T>(
  text: string,
  caret: number,
  fields: readonly QueryField<T>[],
  records: readonly T[] = [],
  options: SuggestionOptions<T> = {},
): SuggestionList | undefined {
  if (text.length > 32768) return undefined
  const tokens = tokenize(text)

  if (tokens.length > 4096) return undefined
  const slot = findSlot(tokens, caret)

  if (!slot) return undefined

  // Inserting in front of an existing word would glue the two together.
  const following = text.charAt(slot.to)

  const insideWord =
    slot.prefix === '' && following !== '' && following !== ' ' && following !== ')'

  if (insideWord) return undefined

  const field = fieldForValue(fields, tokens, slot)

  if (field) return valueSuggestions(field, slot, text, records, options)

  const previousKind = slot.previous?.kind

  const afterOperand =
    previousKind === 'text' ||
    previousKind === 'quoted' ||
    previousKind === 'rparen' ||
    previousKind === 'rbracket'

  // `wot: ` or `pieces:> ` — a space after the colon or comparison leaves the value missing, and
  // suggesting a new field there would only bury the mistake.
  if (previousKind === 'colon' || previousKind === 'compare') return undefined

  return fieldSuggestions(fields, slot, text, afterOperand)
}
