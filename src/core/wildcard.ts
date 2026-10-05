import { QueryValueError } from './errors'

type WildcardPart =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'one' | 'many' }

function scalarEnd(text: string, offset: number): number {
  return offset + (text.codePointAt(offset)! > 0xffff ? 2 : 1)
}

/** Compile source escapes before matching whole indexed tokens without regular-expression backtracking. */
export function compileWildcard(source: string): (term: string) => boolean {
  const parts: WildcardPart[] = []
  let literal = ''

  const flush = () => {
    for (const value of literal) parts.push({ kind: 'literal', value })
    literal = ''
  }

  for (let offset = 0; offset < source.length;) {
    const character = source[offset]!

    if (character === '*' || character === '?') {
      flush()
      const kind = character === '*' ? 'many' : 'one'

      if (kind !== 'many' || parts.at(-1)?.kind !== 'many') parts.push({ kind })
      offset += 1
    } else if (character === '\\') {
      offset += 1

      if (offset === source.length)
        throw new QueryValueError({ message: 'Wildcard has an incomplete escape' })

      if (source[offset] === 'u') {
        const hex = source.slice(offset + 1, offset + 5)

        if (!/^[\da-fA-F]{4}$/.test(hex))
          throw new QueryValueError({ message: 'Wildcard has an invalid Unicode escape' })
        literal += String.fromCharCode(Number.parseInt(hex, 16))
        offset += 5
      } else {
        const end = scalarEnd(source, offset)
        literal += source.slice(offset, end)
        offset = end
      }
    } else {
      const end = scalarEnd(source, offset)
      literal += source.slice(offset, end)
      offset = end
    }
  }

  flush()

  return (term) => {
    let position = 0
    let part = 0
    let star = -1
    let retry = 0

    while (position < term.length) {
      const current = parts[part]

      if (current?.kind === 'many') {
        star = part++
        retry = position
      } else if (current?.kind === 'one') {
        position = scalarEnd(term, position)
        part += 1
      } else if (current?.kind === 'literal' && term.startsWith(current.value, position)) {
        position += current.value.length
        part += 1
      } else if (star >= 0 && retry < term.length) {
        retry = scalarEnd(term, retry)
        position = retry
        part = star + 1
      } else {
        return false
      }
    }

    while (parts[part]?.kind === 'many') part += 1

    return part === parts.length
  }
}
