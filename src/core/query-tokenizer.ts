import type { QueryToken } from './query-types'

const WORD_DELIMITERS = ' \t\n\r()[]":'

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.]*$/

const OPERATOR_WORDS = new Set(['AND', 'OR', 'NOT'])

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r'
}

function readQuoted(input: string, start: number): QueryToken {
  let index = start + 1

  while (index < input.length && input.charAt(index) !== '"') {
    // A backslash escapes the next character, so `\"` does not close the string.
    index += input.charAt(index) === '\\' ? 2 : 1
  }

  const closed = index < input.length
  const end = closed ? index + 1 : input.length

  return { kind: 'quoted', text: input.slice(start, end), start, end, closed }
}

function readWord(input: string, start: number): QueryToken {
  let end = start

  while (end < input.length && !WORD_DELIMITERS.includes(input.charAt(end))) {
    end += 1
  }

  const text = input.slice(start, end)

  if (input.charAt(end) === ':' && IDENTIFIER.test(text)) {
    return { kind: 'field', text, start, end }
  }

  return { kind: OPERATOR_WORDS.has(text) ? 'operator' : 'text', text, start, end }
}

function readToken(input: string, start: number, previous: QueryToken | undefined): QueryToken {
  const char = input.charAt(start)
  const next = input.charAt(start + 1)

  const single = (kind: QueryToken['kind']): QueryToken => ({
    kind,
    text: char,
    start,
    end: start + 1,
  })

  switch (char) {
    case '(':
      return single('lparen')
    case ')':
      return single('rparen')
    case '[':
      return single('lbracket')
    case ']':
      return single('rbracket')
    case ':':
      return single('colon')
    case '"':
      return readQuoted(input, start)
    case '>':
    case '<': {
      const end = next === '=' ? start + 2 : start + 1

      return { kind: 'compare', text: input.slice(start, end), start, end }
    }

    default:
      break
  }

  // `-` negates the term that follows it, including a term that has not been typed yet. After a
  // colon or comparison it is part of a value.
  const startsValue =
    previous?.kind === 'colon' ||
    previous?.kind === 'compare' ||
    previous?.kind === 'lbracket' ||
    previous?.text === 'TO' ||
    (previous?.kind === 'lparen' && /\d/.test(next))

  if (char === '-' && !isWhitespace(next) && !startsValue) {
    return single('minus')
  }

  return readWord(input, start)
}

// Never throws: the editor tokenises on every keystroke, including half-typed input, and the
// highlighter has to colour whatever the user has so far.
export function tokenize(input: string): readonly QueryToken[] {
  const tokens: QueryToken[] = []
  let index = 0

  while (index < input.length) {
    if (isWhitespace(input.charAt(index))) {
      index += 1
      continue
    }

    const token = readToken(input, index, tokens.at(-1))

    tokens.push(token)
    index = token.end
  }

  return tokens
}

// The text a value token stands for, without quotes or escapes.
export function tokenValue(token: QueryToken): string {
  if (token.kind !== 'quoted') return token.text

  const inner = token.closed ? token.text.slice(1, -1) : token.text.slice(1)

  return inner.replace(/\\(["\\])/g, '$1')
}
