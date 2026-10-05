import { describe, expect, test } from 'bun:test'
import {
  createQueryEngine,
  fieldClause,
  hasErrors,
  listClauses,
  parseDate,
  parseQuery,
  removeClause,
  stringifyQuery,
  toggleClause,
} from '../src'
import { compilePhrase } from '../src/core/phrase'
import { fields, records } from './fixtures'

describe('literal phrase building', () => {
  test.each([String.raw`x\" OR *:* OR \"tail`, 'ends with \\', String.raw`literal \\ and "quote"`])(
    'proximity values stay one literal condition: %s',
    (value) => {
      const text = fieldClause({ field: 'value', value, proximity: 2 })
      const parsed = parseQuery(text)

      expect(hasErrors(parsed)).toBe(false)
      expect(parsed.node).toEqual({
        type: 'term',
        field: 'value',
        value: { kind: 'phrase', raw: value, proximity: 2 },
      })
      expect(parseQuery(stringifyQuery(parsed.node)).node).toEqual(parsed.node)

      const engine = createQueryEngine({
        fields: [{ key: 'value', label: 'Value', type: 'keyword', path: 'value' }],
      })

      const input = [{ value }, { value: 'unrelated' }]

      expect(engine.filter(text, input)).toEqual([input[0]])
    },
  )
})

describe('condition composition and removal', () => {
  const engine = createQueryEngine({ fields })

  test.each([
    'status:ready OR status:delayed',
    '(status:ready OR status:delayed)',
    'status:ready OR (status:delayed AND carrier:arc)',
    'NOT status:delivered',
    'status:ready AND NOT carrier:arc',
  ])('a new facet preserves the original predicate: %s', (original) => {
    const next = toggleClause(original, { field: 'tags', value: 'priority' })

    expect(hasErrors(engine.parse(next))).toBe(false)
    expect(engine.filter(next, records)).toEqual(
      engine.filter(original, records).filter(engine.compile('tags:priority').test),
    )
  })

  test.each([
    'carrier:"North Star"',
    'units:[100 TO 200]',
    'carrier:/north.*/',
    'carrier:atlas~1',
    'status:r*',
    '-status:delivered',
    'status:ready^2',
  ])('removes the exact field condition: %s', (text) => {
    const [clause] = listClauses(parseQuery(text).node)

    expect(clause).toBeDefined()

    if (clause) expect(removeClause(text, clause)).toBe('')
  })

  test('removing a prohibited chip preserves the positive spelling of the same value', () => {
    const text = 'status:ready AND NOT status:ready'

    const prohibited = listClauses(parseQuery(text).node).find(
      (clause) => clause.occur === 'must-not',
    )

    expect(prohibited).toBeDefined()

    if (prohibited) {
      expect(listClauses(parseQuery(removeClause(text, prohibited)).node)).toMatchObject([
        { occur: 'must', value: { raw: 'ready' } },
      ])
    }
  })
})

describe('date timezone normalization', () => {
  test.each([
    ['2026-10-24T11:30:00+02:00', '2026-10-24T09:30:00Z'],
    ['2026-10-24T11:30:00+0200', '2026-10-24T09:30:00Z'],
    ['2026-10-24T11:30:00-05:30', '2026-10-24T17:00:00Z'],
    ['2026-10-24T11:30:00-0530', '2026-10-24T17:00:00Z'],
    ['2026-10-24T11:30:00.123+02:00', '2026-10-24T09:30:00.123Z'],
  ])('%s denotes the same window as %s', (offset, utc) => {
    expect(parseDate(offset)).toEqual(parseDate(utc))
    expect(parseDate(offset)).not.toBeNull()
  })

  test('date terms and ranges include records stored with ISO offsets', () => {
    const engine = createQueryEngine({
      fields: [{ key: 'date', label: 'Date', type: 'date', path: 'date' }],
    })

    const input = [
      { date: '2026-10-24T11:30:00+02:00' },
      { date: '2026-10-24T09:30:00Z' },
      { date: '2026-10-25T11:30:00+02:00' },
    ]

    expect(engine.filter('date:2026-10-24', input)).toEqual(input.slice(0, 2))
    expect(engine.filter('date:[2026-10-24 TO 2026-10-24]', input)).toEqual(input.slice(0, 2))
  })
})

describe('text multi-term patterns', () => {
  const engine = createQueryEngine({
    fields: [{ key: 'text', label: 'Text', type: 'text', path: 'text' }],
  })

  const input = [{ text: 'north star' }, { text: 'arc' }, { text: '' }, { text: '!!!' }]

  test.each(['text:*', 'text:/.*/', 'text:/@/'])('%s matches indexed tokens', (query) => {
    expect(engine.filter(query, input)).toEqual(input.slice(0, 2))
  })

  test('pattern syntax is not passed through a custom term analyzer', () => {
    const analyzed: string[] = []

    const custom = createQueryEngine({
      fields: [
        {
          key: 'text',
          label: 'Text',
          type: 'text',
          path: 'text',
          analyze: (text) => {
            analyzed.push(text)

            return text.toLowerCase().split(/\s+/u)
          },
        },
      ],
    })

    expect(custom.filter('text:/n.*/', [{ text: 'NORTH' }])).toEqual([{ text: 'NORTH' }])
    expect(analyzed).toEqual(['NORTH'])
  })
})

/** Exhaustive oracle, intentionally limited to tiny inputs, independent of the optimized matcher. */
function minimumMovement(query: readonly string[], tokens: readonly string[]): number {
  let best = Infinity
  const used = new Set<number>()
  const deltas: number[] = []

  function visit(offset: number): void {
    if (offset === query.length) {
      const sorted = [...deltas].sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0
      let movement = 0

      for (const delta of sorted) movement += Math.abs(delta - median)
      best = Math.min(best, movement)

      return
    }

    tokens.forEach((word, position) => {
      if (word !== query[offset] || used.has(position)) return
      used.add(position)
      deltas.push(position - offset)
      visit(offset + 1)
      deltas.pop()
      used.delete(position)
    })
  }

  visit(0)

  return best
}

describe('bounded phrase matching', () => {
  test('rejects missing terms and insufficient repeated positions without permutation search', () => {
    const repeated = Array<string>(14).fill('a')
    const start = performance.now()

    expect(compilePhrase([...repeated, 'b'], 100)([...repeated, 'c'])).toBe(false)
    expect(compilePhrase([...repeated, 'a'], 100)([...repeated, 'b'])).toBe(false)
    expect(
      compilePhrase([...repeated, 'b'], 400)([...repeated, ...Array<string>(500).fill('x'), 'b']),
    ).toBe(false)
    expect(performance.now() - start).toBeLessThan(1000)
  })

  test('agrees with minimum movement for repeated, transposed, and separated terms', () => {
    const queries = [
      ['a', 'b'],
      ['a', 'a'],
      ['a', 'b', 'a'],
      ['b', 'a', 'b'],
    ]

    const inputs = [
      ['a', 'b'],
      ['b', 'a'],
      ['a', 'x', 'b', 'a'],
      ['b', 'a', 'b', 'a', 'b'],
      ['a', 'a', 'x', 'b', 'b'],
    ]

    for (const query of queries) {
      for (const input of inputs) {
        const movement = minimumMovement(query, input)

        for (let proximity = 0; proximity <= 8; proximity += 1) {
          expect(compilePhrase(query, proximity)(input)).toBe(movement <= proximity)
        }
      }
    }
  })
})
