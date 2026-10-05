import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'
import { hasErrors } from '../src/core/parser'
import { createQueryEngine } from '../src/engine-adapter'
import {
  QueryDocument,
  QueryTranslationError,
  fromQueryJson,
  toQueryJson,
  type JsonQueryNode,
} from '../src/query-json'
import { fields, records } from './fixtures'
import { outputFields, postgresParityQueries } from './output-fixtures'

interface CyclicDocument {
  self?: CyclicDocument
}

type NestedDocument = null | { nested: NestedDocument }

const engine = createQueryEngine({ fields })

const value = <A>(result: Result.Result<A, QueryTranslationError>): A => Result.getOrThrow(result)

describe('versioned query JSON', () => {
  test('empty queries use null, not a missing tree', () => {
    expect(value(toQueryJson(engine.parse('')))).toEqual({ version: 1, node: null })
    expect(value(fromQueryJson({ version: 1, node: null }, fields)).node).toBeUndefined()
  })

  test('unqualified fields and open bounds use explicit null', () => {
    expect(value(toQueryJson(engine.parse('north')))).toEqual({
      version: 1,
      node: { type: 'term', field: null, value: { kind: 'term', raw: 'north' } },
    })
    expect(value(toQueryJson(engine.parse('units:[* TO 100]')))).toEqual({
      version: 1,
      node: {
        type: 'term',
        field: 'units',
        value: { kind: 'range', from: null, to: '100', includeLower: true, includeUpper: true },
      },
    })
  })

  test.each([
    ...postgresParityQueries,
    'carrier:no*',
    'carrier:n\\\\u006fr*',
    'carrier:/north\\/star/',
    'carrier:/a\\\\\\/b/',
    'status:re\\\\?ady',
    'carrier:/n.*h/',
    'carrier:north~0.8',
    'carrier:"north star"~2^3',
    '+status:ready -status:delayed',
    '(status:ready OR status:delayed)^2',
    '(status:ready)',
    '((status:ready))',
    '(+status:ready)',
    '(-status:ready)',
    '(status:ready)^2',
    '(status:ready^2)',
    'status:(ready OR delayed)',
    'units:["*" TO 100]',
    'status:ready AND carrier:no*',
  ])('JSON round-trip preserves matching: %s', (text) => {
    const document = value(toQueryJson(engine.parse(text)))
    const wire: unknown = JSON.parse(JSON.stringify(document))
    const parsed = value(fromQueryJson(wire, fields))
    expect(engine.filter(parsed.text, records)).toEqual(engine.filter(text, records))
    expect(parsed.node).toEqual(engine.parse(text).node)
  })

  test('only the tree is exported, not source text, tokens, accessors, or diagnostics', () => {
    const document = value(toQueryJson(engine.parse('missing:ready')))
    expect(Object.keys(document)).toEqual(['version', 'node'])
    expect(Schema.decodeUnknownResult(QueryDocument)(document)._tag).toBe('Success')
  })

  test('invalid editor drafts cannot be exported', () => {
    const result = toQueryJson(engine.parse('status:('))
    expect(Result.isFailure(result) && result.failure.code).toBe('invalid-query')
  })

  test.each([
    {},
    { version: 2, node: null },
    { version: 1 },
    { version: 1, node: null, extra: true },
    { version: 1, node: { type: 'term', field: null, value: { kind: 'bogus', raw: 'x' } } },
    { version: 1, node: { type: 'boolean', clauses: [] } },
    {
      version: 1,
      node: { type: 'term', field: 'status', value: { kind: 'term', raw: 'ready', extra: true } },
    },
    {
      version: 1,
      node: { type: 'term', field: 'status', value: { kind: 'term', raw: 'ready' }, boost: 0 },
    },
    {
      version: 1,
      node: {
        type: 'term',
        field: 'status',
        value: { kind: 'fuzzy', raw: 'ready', distance: 1.5 },
      },
    },
    {
      version: 1,
      node: {
        type: 'term',
        field: 'status',
        value: { kind: 'phrase', raw: 'ready', proximity: -1 },
      },
    },
    { version: 1, node: { type: 'term', field: 'status', value: { kind: 'regex', raw: '[' } } },
    {
      version: 1,
      node: { type: 'term', field: 'status', value: { kind: 'wildcard', raw: 'x\\' } },
    },
  ])('malformed or semantically invalid wire documents are rejected: %j', (document) => {
    expect(Result.isFailure(fromQueryJson(document, fields))).toBe(true)
  })

  test('wire decoding never silently changes a wildcard into an analyzed term', () => {
    const document = {
      version: 1,
      node: { type: 'term', field: 'carrier', value: { kind: 'wildcard', raw: 'NORTH' } },
    }

    const result = fromQueryJson(document, fields)

    expect(Result.isFailure(result) && result.failure.code).toBe('invalid-json')
  })

  test('wire object property order does not affect decoding', () => {
    const document = {
      node: { value: { raw: 'ready', kind: 'term' }, field: 'status', type: 'term' },
      version: 1,
    }

    expect(Result.isSuccess(fromQueryJson(document, fields))).toBe(true)
  })

  test('receiving fields and unknown-field policy are authoritative', () => {
    const document = value(toQueryJson(engine.parse('status:ready')))
    expect(Result.isSuccess(fromQueryJson(document, outputFields))).toBe(true)
    const result = fromQueryJson(document, [], { unknownFields: 'error' })
    expect(Result.isFailure(result) && result.failure.code).toBe('invalid-query')
  })

  test('oversized, deeply nested, and cyclic input fails before recursive decoding', () => {
    const cyclic: CyclicDocument = {}
    cyclic.self = cyclic
    let nested: NestedDocument = null

    for (let index = 0; index < 405; index += 1) nested = { nested }

    for (const input of [
      cyclic,
      nested,
      { version: 1, node: 'x'.repeat(131073) },
      Array(32769).fill(null),
      { ['x'.repeat(131073)]: null },
    ]) {
      const result = fromQueryJson(input, fields)
      expect(Result.isFailure(result) && result.failure.code).toBe('query-limit')
    }
  })

  test('inherited cyclic wire properties are rejected before Schema decoding', () => {
    const clauses: { occur: 'should'; node: JsonQueryNode }[] = []
    const node: JsonQueryNode = { type: 'boolean', clauses }
    clauses.push({ occur: 'should', node })

    for (const input of [
      Object.create({ version: 1, node }),
      { version: 1, node: Object.create(node) },
    ]) {
      const result = fromQueryJson(input, fields)
      expect(Result.isFailure(result) && result.failure.code).toBe('invalid-json')
    }
  })

  test('accessors and hidden wire properties cannot evade preflight', () => {
    let reads = 0

    const accessor = {
      version: 1,
      get node() {
        reads += 1

        return null
      },
    }

    const hidden = Object.defineProperty({ version: 1 }, 'node', { value: null })

    for (const input of [accessor, hidden]) {
      const result = fromQueryJson(input, fields)
      expect(Result.isFailure(result) && result.failure.code).toBe('invalid-json')
    }

    expect(reads).toBe(0)
  })

  test('null-prototype data objects remain valid wire inputs', () => {
    const document: unknown = Object.assign(Object.create(null), { version: 1, node: null })
    expect(value(fromQueryJson(document, fields)).node).toBeUndefined()
  })

  test('valid queries near text and token limits still round-trip', () => {
    for (const text of [Array(2048).fill('x').join(' AND '), 'x'.repeat(32766) + ' y']) {
      const original = engine.parse(text)
      expect(hasErrors(original)).toBe(false)
      const document = value(toQueryJson(original))
      const wire: unknown = JSON.parse(JSON.stringify(document))
      const restored = value(fromQueryJson(wire, fields))
      expect(restored.node).toEqual(original.node)
    }
  })

  test('export rejects canonical text that cannot fit the receiving parser budgets', () => {
    const text = `status:[a TO ${'x'.repeat(32768 - 'status:[a TO ]'.length)}]`
    const parsed = engine.parse(text)
    expect(hasErrors(parsed)).toBe(false)
    const result = toQueryJson(parsed)
    expect(Result.isFailure(result) && result.failure.code).toBe('invalid-query')
  })

  test('canonical query text retains parser size limits', () => {
    const result = fromQueryJson(
      {
        version: 1,
        node: { type: 'term', field: null, value: { kind: 'term', raw: 'x'.repeat(32769) } },
      },
      fields,
    )

    expect(Result.isFailure(result) && result.failure.code).toBe('invalid-query')
  })
})
