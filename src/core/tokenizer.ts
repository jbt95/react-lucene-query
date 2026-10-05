import type { QueryToken, TokenKind } from './types'

const OPERATOR_WORDS = new Set(['AND', 'OR', 'NOT'])

const PUNCTUATION = new Map<string, TokenKind>([
  [':', 'colon'],
  ['(', 'lparen'],
  [')', 'rparen'],
  ['[', 'lbracket'],
  [']', 'rbracket'],
  ['{', 'lbrace'],
  ['}', 'rbrace'],
  ['~', 'tilde'],
  ['^', 'caret'],
  ['+', 'plus'],
  ['-', 'minus'],
  ['!', 'operator'],
])

function readDelimited(input: string, start: number, delimiter: string): QueryToken {
  let end = start + 1

  while (end < input.length && input.charAt(end) !== delimiter) {
    end += input.charAt(end) === '\\' ? 2 : 1
  }

  const closed = end < input.length
  end = closed ? end + 1 : input.length

  return {
    kind: delimiter === '"' ? 'quoted' : 'regex',
    text: input.slice(start, end),
    start,
    end,
    closed,
  }
}

function readWord(input: string, start: number, inRange: boolean): QueryToken {
  let end = start

  while (end < input.length) {
    const char = input.charAt(end)

    if (char === '\\') {
      end = Math.min(input.length, end + 2)
      continue
    }

    if (/\s/u.test(char) || (inRange ? '[]{}"' : '()[]{}":/^~!&|').includes(char)) break
    end += 1
  }

  // A single reserved symbol still makes progress and receives a syntax diagnostic.
  if (end === start) end += 1
  const text = input.slice(start, end)

  const kind =
    !inRange && input.charAt(end) === ':'
      ? 'field'
      : !inRange && OPERATOR_WORDS.has(text)
        ? 'operator'
        : 'text'

  return { kind, text, start, end }
}

// Bounded, tolerant tokenization keeps incomplete editor input safe to highlight.
export function tokenize(input: string): readonly QueryToken[] {
  const tokens: QueryToken[] = []
  const source = input.slice(0, 32769)
  let index = 0
  let inRange = false

  while (index < source.length && tokens.length <= 4096) {
    const char = source.charAt(index)

    if (/\s/u.test(char)) {
      index += 1
      continue
    }

    let token: QueryToken

    if (char === '"' || (char === '/' && !inRange)) {
      token = readDelimited(source, index, char)
    } else if (
      !inRange &&
      (source.slice(index, index + 2) === '&&' || source.slice(index, index + 2) === '||')
    ) {
      token = {
        kind: 'operator',
        text: source.slice(index, index + 2),
        start: index,
        end: index + 2,
      }
    } else {
      const kind = PUNCTUATION.get(char)

      if (kind && (!inRange || '[]{}'.includes(char))) {
        token = { kind, text: char, start: index, end: index + 1 }
      } else {
        token = readWord(source, index, inRange)
      }
    }

    if (token.kind === 'lbracket' || token.kind === 'lbrace') inRange = true

    if (token.kind === 'rbracket' || token.kind === 'rbrace') inRange = false
    tokens.push(token)
    index = token.end
  }

  return tokens
}

// Syntax validation belongs to the parser; incomplete escapes remain useful in completion.
export function tokenValue(token: QueryToken): string {
  if (token.kind === 'regex') return token.closed ? token.text.slice(1, -1) : token.text.slice(1)

  const inner =
    token.kind === 'quoted'
      ? token.closed
        ? token.text.slice(1, -1)
        : token.text.slice(1)
      : token.text

  return inner.replace(
    /\\u([\da-fA-F]{4})|\\([\s\S])/g,
    (_, unicode: string | undefined, escaped: string | undefined) =>
      unicode === undefined ? (escaped ?? '') : String.fromCharCode(Number.parseInt(unicode, 16)),
  )
}
