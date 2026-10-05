import { describe, expect, test } from 'bun:test'
import { hasErrors, parseQuery, type QueryField } from '../src/core'
import { createQueryEngine } from '../src/engine-adapter'

const fields: readonly QueryField<{ readonly units: number; readonly active: boolean }>[] = [
  { key: 'units', label: 'Units', type: 'keyword', read: (record) => record.units },
  { key: 'active', label: 'Active', type: 'keyword', read: (record) => record.active },
]

const engine = createQueryEngine({ fields })

const record = { units: -1, active: true }

describe('exact parser budgets', () => {
  test('text budget counts UTF-16 code units and includes the final permitted unit', () => {
    for (const text of ['x'.repeat(32768), '😀'.repeat(16384)]) {
      expect(text.length).toBe(32768)
      expect(hasErrors(engine.parse(text))).toBe(false)
      const rejected = engine.parse(text + 'x')
      expect(hasErrors(rejected)).toBe(true)
      expect(rejected.tokens).toEqual([])
      expect(rejected.node).toBeUndefined()
      expect(engine.compile(text + 'x').test(record)).toBe(false)
    }
  })

  test('token budget accepts its boundary and rejects the next condition', () => {
    const text = Array.from({ length: 4096 }, () => 'x').join(' ')
    const parsed = engine.parse(text)
    expect(parsed.tokens.length).toBe(4096)
    expect(hasErrors(parsed)).toBe(false)
    expect(parsed.node?.type).toBe('boolean')

    if (parsed.node?.type !== 'boolean') throw new Error('Expected Boolean clauses')
    expect(parsed.node.clauses.every((clause) => clause.occur === 'should')).toBe(true)
    const rejected = engine.parse(text + ' x')
    expect(hasErrors(rejected)).toBe(true)
    expect(engine.compile(text + ' x').test(record)).toBe(false)
  })

  test('group nesting includes its boundary without losing the predicate', () => {
    const text = '('.repeat(100) + 'active:true' + ')'.repeat(100)
    expect(hasErrors(engine.parse(text))).toBe(false)
    expect(engine.compile(text).test(record)).toBe(true)
    const rejected = engine.parse(`(${text})`)
    expect(hasErrors(rejected)).toBe(true)
    expect(engine.compile(`(${text})`).test(record)).toBe(false)
  })

  test('prohibited groups do not turn pure negatives into complement queries', () => {
    const text = '('.repeat(99) + '-active:false' + ')'.repeat(99)
    expect(hasErrors(engine.parse(text))).toBe(false)
    expect(engine.compile(text).test(record)).toBe(false)
    expect(engine.compile('*:* AND NOT (active:false)').test(record)).toBe(true)
  })

  test('wide groups and independent prohibited clauses reset their nesting counters', () => {
    const text = Array.from({ length: 200 }, () => '(*:* AND NOT active:false)').join(' OR ')
    expect(hasErrors(engine.parse(text))).toBe(false)
    expect(engine.compile(text).test(record)).toBe(true)
  })
})

describe('negative keyword values', () => {
  test.each([
    ['units:("-1" OR "-2")', [-1, -2]],
    ['units:("-0.5" OR 1)', [-0.5, 1]],
    ['units:(1 OR "-0.5")', [1, -0.5]],
    ['units:("-0.01" OR "-20")', [-0.01, -20]],
    [String.raw`units:\-1`, [-1]],
    ['units:(-1 OR -2)', []],
  ])('%s uses scalar keyword spelling and clause modifiers', (text, expected) => {
    const records = [-20, -2, -1, -0.5, -0.01, 0, 1].map((units) => ({ units, active: true }))
    expect(hasErrors(engine.parse(text))).toBe(false)
    expect(engine.filter(text, records).map((item) => item.units)).toEqual(
      records.flatMap((item) => (expected.includes(item.units) ? [item.units] : [])),
    )
  })

  test('prohibited clauses require a positive clause to match records', () => {
    const records = [record, { units: -2, active: true }]
    expect(engine.filter('-units:"-1"', records)).toEqual([])
    expect(engine.filter('*:* AND -units:"-1"', records)).toEqual([records[1]!])
  })

  test('quoted negative field groups fit the group nesting budget', () => {
    const text = '('.repeat(99) + 'units:("-0.5" OR "-1")' + ')'.repeat(99)
    expect(hasErrors(engine.parse(text))).toBe(false)
    expect(engine.compile(text).test(record)).toBe(true)
  })

  test('keyword values do not receive numeric or boolean validation', () => {
    for (const text of ['units:many', 'active:maybe', 'units:>1', 'units:(1 AND 2)']) {
      expect(hasErrors(engine.parse(text))).toBe(false)
      expect(engine.compile(text).test(record)).toBe(false)
    }
  })
})

describe('adversarial grammar shapes', () => {
  test.each([
    'AND active:true',
    'OR active:true',
    'active:true OR OR active:false',
    'NOT',
    'NOT NOT active:true',
    '--active:true',
    '+-active:true',
    'active:true ) active:false',
    'units:[1 TO 2',
    'units:[1 TO]',
    'units:(1 OR)',
    'active:"true',
    '((()))',
    'active:true ]',
    'units:1^0',
    'units:1~bad',
  ])('invalid partial AST never executes: %s', (text) => {
    const parsed = parseQuery(text, fields)
    expect(hasErrors(parsed)).toBe(true)
    expect(parsed.roles.length).toBe(parsed.tokens.length)

    for (const token of parsed.tokens) {
      expect(text.slice(token.start, token.end)).toBe(token.text)
    }

    expect(engine.compile(text).test(record)).toBe(false)
  })

  test('default OR and classic clause occurrence rules require explicit grouping', () => {
    const records = [
      { units: -1, active: true },
      { units: -1, active: false },
      { units: 2, active: false },
      { units: 3, active: true },
    ]

    expect(engine.filter('units:"-1" active:true OR units:2', records)).toEqual(records)
    expect(engine.filter('units:"-1" AND active:true OR units:2', records)).toEqual([records[0]!])
    expect(engine.filter('(units:"-1" AND active:true) OR units:2', records)).toEqual([
      records[0]!,
      records[2]!,
    ])
    expect(engine.filter('NOT (units:"-1" OR active:false)', records)).toEqual([])
    expect(engine.filter('*:* AND NOT (units:"-1" OR active:false)', records)).toEqual([
      records[3]!,
    ])
  })
})
