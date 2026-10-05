import { describe, expect, test } from 'bun:test'
import {
  and,
  escapeFieldName,
  escapeTerm,
  fieldClause,
  listClauses,
  not,
  or,
  parseQuery,
  QueryValueError,
  stringifyQuery,
  toggleClause,
} from '../src'

/** The property that makes building safe: what the parser reads back is what was built. */
function canonical(text: string): string {
  return stringifyQuery(parseQuery(text).node)
}

describe('escapeTerm', () => {
  test('leaves an ordinary term alone', () => {
    expect(escapeTerm('ready')).toBe('ready')
    expect(escapeTerm('ready_2')).toBe('ready_2')
  })

  test('quotes anything that could otherwise change the query', () => {
    expect(escapeTerm('')).toBe('""')
    expect(escapeTerm('a b')).toBe('"a b"')
    expect(escapeTerm('a:b')).toBe('"a:b"')
    expect(escapeTerm('a AND b')).toBe('"a AND b"')
    expect(escapeTerm('TO')).toBe('"TO"')
    expect(escapeTerm('*')).toBe('"*"')
    expect(escapeTerm('a-b')).toBe('"a-b"')
    expect(escapeTerm('(a)')).toBe('"(a)"')
  })

  test('keeps a wildcard or operator inside the value literal', () => {
    expect(parseQuery(`status:${escapeTerm('*:*')}`).node).toBeDefined()
    expect(canonical(`status:${escapeTerm('ready OR *:*')}`)).toBe('status:"ready OR *:*"')
  })

  test('escapes quotes and backslashes instead of ending the term', () => {
    const value = 'a"b\\c'

    expect(escapeTerm(value)).toBe('"a\\"b\\\\c"')
    // Reading it back yields the original value, which is the whole point of escaping.
    expect(canonical(`status:${escapeTerm(value)}`)).toBe('status:"a\\"b\\\\c"')
    expect(parseQuery(`status:${escapeTerm(value)}`).node).toBeDefined()
  })

  test('an injected clause cannot widen the query', () => {
    const hostile = 'x" OR status:*"'
    const query = `status:${escapeTerm(hostile)}`

    expect(canonical(query)).toBe(`status:"x\\" OR status:*\\""`)
  })
})

describe('escapeFieldName', () => {
  test('escapes reserved characters instead of quoting them', () => {
    expect(escapeFieldName('a:b')).toBe('a\\:b')
    expect(escapeFieldName('a b')).toBe('a\\ b')
    expect(escapeFieldName('AND')).toBe('\\AND')
  })

  test('rejects an empty field name, which no query could express', () => {
    // Typed rather than a bare RangeError, so the engine can map it into its error channel.
    expect(() => escapeFieldName('')).toThrow(QueryValueError)
  })

  test('an escaped name round-trips through the parser', () => {
    expect(canonical(`${escapeFieldName('a:b')}:x`)).toBe('a\\:b:x')
  })
})

describe('fieldClause', () => {
  test('builds one condition with both sides escaped', () => {
    expect(fieldClause({ field: 'status', value: 'ready' })).toBe('status:ready')
    expect(fieldClause({ field: 'status', value: 'a b' })).toBe('status:"a b"')
    expect(fieldClause({ field: 'a:b', value: 'x' })).toBe('a\\:b:x')
  })

  test('adds the supported modifiers', () => {
    expect(fieldClause({ field: 's', value: 'ready', boost: 2 })).toBe('s:ready^2')
    expect(fieldClause({ field: 's', value: 'red', fuzzy: 1 })).toBe('s:red~1')
    expect(fieldClause({ field: 's', value: 'north star', proximity: 5 })).toBe('s:"north star"~5')
  })

  test('rejects modifiers that cannot be expressed', () => {
    for (const clause of [
      { field: 's', value: 'x', boost: 0 },
      { field: 's', value: 'x', boost: Number.NaN },
      { field: 's', value: 'x', fuzzy: 1, proximity: 2 },
    ]) {
      expect(() => fieldClause(clause)).toThrow(QueryValueError)
    }
  })
})

describe('and, or, not', () => {
  test('joins with the classic operators, parenthesized so nesting stays correct', () => {
    expect(and('a', 'b')).toBe('(a AND b)')
    expect(or('a', 'b')).toBe('(a OR b)')
    expect(and('a')).toBe('a')
    expect(not('a')).toBe('NOT a')
  })

  test('drops empty parts instead of producing a broken query', () => {
    expect(and()).toBe('')
    expect(and('a', '')).toBe('a')
    expect(or('', 'b')).toBe('b')
    expect(not('')).toBe('')
  })

  test('a composed query parses to the same tree it describes', () => {
    const query = and(fieldClause({ field: 'status', value: 'ready' }), not('deleted'))

    expect(parseQuery(query).node).toEqual(parseQuery('(status:ready AND NOT deleted)').node)
  })

  test('a negated disjunction is one condition, not two', () => {
    expect(parseQuery(not(or('a', 'b'))).node).toEqual(parseQuery('NOT (a OR b)').node)
  })

  test('a disjunction of conjunctions keeps each group intact', () => {
    expect(parseQuery(or(and('a', 'b'), and('c', 'd'))).node).toEqual(
      parseQuery('((a AND b) OR (c AND d))').node,
    )
  })

  test('hostile values cannot escape their clause through composition', () => {
    const query = and(
      fieldClause({ field: 'status', value: 'ready' }),
      fieldClause({ field: 'q', value: '*:*' }),
    )

    expect(parseQuery(query).node).toEqual(parseQuery('(status:ready AND q:"*:*")').node)
  })
})

describe('listClauses', () => {
  test('flattens an AST into removable conditions', () => {
    const clauses = listClauses(
      parseQuery('status:ready AND (carrier:"North Star" OR units:[1 TO 2])').node,
    )

    expect(clauses.map((clause) => clause.text)).toEqual([
      'status:ready',
      'carrier:"North Star"',
      'units:["1" TO "2"]',
    ])
    expect(clauses[1]?.field).toBe('carrier')
  })

  test('an empty or invalid query has no clauses', () => {
    expect(listClauses(parseQuery('').node)).toEqual([])
    expect(listClauses(parseQuery('status:[a TO').node)).toEqual([])
  })

  test('a bare term has no field, which is why its chip cannot be removable', () => {
    const [clause] = listClauses(parseQuery('north').node)

    expect(clause?.field).toBeUndefined()
  })
})

describe('toggleClause', () => {
  test('round-trips a condition regardless of how it was written', () => {
    const once = toggleClause('status:ready', { field: 'carrier', value: 'North Star' })
    const twice = toggleClause(once, { field: 'carrier', value: 'North Star' })

    // The canonical form keeps Lucene's required prefix, and is a fixed point of its own round
    // trip, which is the property a caller can rely on when it stores the text.
    expect(twice).toBe('(+status:ready)')
    expect(canonical(twice)).toBe(twice)
  })

  test('quoted and unquoted spellings are the same condition', () => {
    expect(toggleClause('status:"ready"', { field: 'status', value: 'ready' })).toBe('')
  })

  test('a group that loses its last clause disappears with it', () => {
    const group = toggleClause('(status:ready)', { field: 'carrier', value: 'Arc' })
    const empty = toggleClause(group, { field: 'status', value: 'ready' })
    const alsoEmpty = toggleClause(empty, { field: 'carrier', value: 'Arc' })

    expect(empty).toBe('(+carrier:Arc)')
    expect(parseQuery(empty).node).toBeDefined()
    expect(alsoEmpty).toBe('')
  })
})
