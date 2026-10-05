import { describe, expect, test } from 'bun:test'
import {
  compileQuery,
  filterRecords,
  matchesQuery,
  parseQuery,
  stringifyQuery,
  tokenize,
  tokenValue,
  type QueryField,
} from '../src/core'
import { findQueryField } from '../src/core/fields'
import { createQueryEngine } from '../src/engine-adapter'

const fields: readonly QueryField<{ readonly value: string | null | undefined }>[] = [
  { key: 'value', label: 'Value', type: 'keyword', read: (record) => record.value, freeText: true },
]

const engine = createQueryEngine({ fields })

describe('keyword wildcard matching', () => {
  test.each([
    ['a*bc', ['abc', 'abbc', 'axybc']],
    ['ab*bc', ['abbc']],
    ['a**b***c', ['abc', 'abbc', 'axybc']],
    ['*', ['abc', 'abbc', 'axybc', 'AB.C', 'a+b']],
    ['AB.C', ['AB.C']],
    [String.raw`a\+b`, ['a+b']],
    ['*BC', []],
    ['abc*', ['abc']],
  ])('%s matches complete case-sensitive keyword values', (pattern, expected) => {
    const records = ['abc', 'abbc', 'axybc', 'AB.C', 'a+b', '', null, undefined].map((value) => ({
      value,
    }))

    expect(engine.filter(`value:${pattern}`, records).map((record) => record.value)).toEqual(
      expected,
    )
  })

  test('blank keyword values are unindexed, so no pattern reaches them', () => {
    const records = ['', '   ', 'abc'].map((value) => ({ value }))

    for (const pattern of ['*', 'abc', 'a*']) {
      expect(engine.filter(`value:${pattern}`, records).map((record) => record.value)).toEqual([
        'abc',
      ])
    }
  })

  test('escaped wildcard characters remain literal', () => {
    const records = [{ value: 'a*b' }, { value: 'a?b' }, { value: 'axb' }]
    expect(engine.filter(String.raw`value:a\*b`, records)).toEqual([records[0]!])
    expect(engine.filter(String.raw`value:a\?b`, records)).toEqual([records[1]!])
    expect(engine.filter('value:a?b', records)).toEqual(records)
  })

  test('regexp symbols in quoted keywords remain literal', () => {
    const records = ['[a-z]+', '(foo|bar)?', '^start$', 'plain'].map((value) => ({ value }))

    for (const record of records) {
      expect(engine.filter(`value:"${record.value}"`, records)).toEqual([record])
    }
  })

  test('quoted Unicode and whitespace keywords retain their contents', () => {
    for (const value of ['😀 café', 'line\nbreak', 'tab\tvalue']) {
      const record = { value }
      expect(engine.filter(`value:"${value}"`, [record])).toEqual([record])
    }
  })
})

describe('token helpers', () => {
  test('unquoted numeric signs are clause modifiers even inside field groups', () => {
    expect(tokenize('value:(-1 OR +2)').map((token) => token.kind)).toEqual([
      'field',
      'colon',
      'lparen',
      'minus',
      'text',
      'operator',
      'plus',
      'text',
      'rparen',
    ])
    expect(tokenize('value:("-1" OR "-2")').map((token) => token.kind)).toEqual([
      'field',
      'colon',
      'lparen',
      'quoted',
      'operator',
      'quoted',
      'rparen',
    ])
    const records = [{ value: '2' }, { value: 'other' }]
    expect(engine.filter('(-2)', records)).toEqual([])
    expect(engine.filter('*:* AND -value:2', records)).toEqual([records[1]!])
  })

  test('whitespace leaves token offsets aligned with the original input', () => {
    const text = '\tvalue:"😀 café"\nAND\r value:a*\t'
    const tokens = tokenize(text)
    expect(tokens.map((token) => token.kind)).toEqual([
      'field',
      'colon',
      'quoted',
      'operator',
      'field',
      'colon',
      'text',
    ])
    expect(tokens.map(tokenValue)).toEqual(['value', ':', '😀 café', 'AND', 'value', ':', 'a*'])

    for (const token of tokens) {
      expect(text.slice(token.start, token.end)).toBe(token.text)
    }
  })

  test('quoted arbitrary escapes and Unicode escapes are decoded', () => {
    const tokens = tokenize(String.raw`"quote: \" slash: \\ arbitrary: \q unicode: \u00e9"`)
    expect(tokens.length).toBe(1)
    expect(tokenValue(tokens[0]!)).toBe('quote: " slash: \\ arbitrary: q unicode: é')
    expect(tokens[0]?.closed).toBe(true)
  })

  test('unfinished quotes and trailing escapes remain bounded tokens', () => {
    for (const text of ['"', '"partial', '"trailing\\']) {
      const tokens = tokenize(text)
      expect(tokens.length).toBe(1)
      expect(tokens[0]?.closed).toBe(false)
      expect(tokens[0]?.end).toBe(text.length)
    }
  })
})

describe('field lookup', () => {
  test('field names are case-sensitive and do not accept partial keys', () => {
    expect(findQueryField(fields, 'value')).toBe(fields[0])
    expect(findQueryField(fields, 'VALUE')).toBeUndefined()
    expect(findQueryField(fields, 'valu')).toBeUndefined()
  })
})

describe('low-level predicate helpers', () => {
  test('valid parsed ASTs produce the same result through each helper', () => {
    const records = [{ value: 'alpha' }, { value: 'beta' }, { value: null }]
    const parsed = parseQuery('value:a*', fields)
    const node = parsed.node

    if (!node) throw new Error('Expected a parsed query node')
    const predicate = compileQuery(node, fields)
    expect(records.filter(predicate)).toEqual([records[0]!])
    expect(filterRecords(node, fields, records)).toEqual([records[0]!])
    expect(records.filter((record) => matchesQuery(node, fields, record))).toEqual([records[0]!])
    expect(engine.filter(stringifyQuery(node), records)).toEqual([records[0]!])
  })

  test('an absent AST is unrestricted and keeps the immutable records array', () => {
    const records = [{ value: null }]
    expect(filterRecords(undefined, fields, records)).toBe(records)
    expect(compileQuery(undefined, fields)(records[0]!)).toBe(true)
    expect(stringifyQuery(undefined)).toBe('')
  })
})
