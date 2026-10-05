import { describe, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'
import { createQueryEngine, QueryConfigurationError, stringifyQuery, type QueryField } from '../src'
import { QueryEngine } from '../src/core'

const field: QueryField<{ readonly value: string }> = {
  key: 'value',
  label: 'Value',
  type: 'keyword',
  read: (record) => record.value,
}

// Untrusted boundary fixture. These values deliberately violate the TypeScript field contract,
// exactly as a JavaScript consumer would. `QueryEngine.make` decodes them with Schema and raises
// QueryConfigurationError, which is the behaviour under test.
function fieldsFromUntrusted(...candidates: readonly unknown[]) {
  // SAFETY: the candidates are deliberately mistyped, so the only way to reach the typed
  // constructor is to erase the type at this one documented seam.
  return { fields: candidates } as never
}

// Keep these configuration cases separate from the language conformance suite.
describe('strict language engine configuration', () => {
  test('field names remain case-sensitive', () => {
    const fields: readonly QueryField<{ readonly upper: string; readonly lower: string }>[] = [
      { ...field, key: 'Code', read: (record) => record.upper },
      { ...field, key: 'code', read: (record) => record.lower },
    ]

    const engine = createQueryEngine({ fields })
    const record = { upper: 'UPPER', lower: 'lower' }

    expect(engine.filter('Code:UPPER', [record])).toEqual([record])
    expect(engine.filter('code:lower', [record])).toEqual([record])
    expect(engine.filter('Code:lower', [record])).toEqual([])
    expect(engine.filter('CODE:UPPER', [record])).toEqual([])
  })

  test.each(['shipping country', 'a:b', '+', 'AND', '雪', 'with\\backslash'])(
    'escape-representable field %s can be configured and searched',
    (key) => {
      const engine = createQueryEngine({ fields: [{ ...field, key }] })
      const record = { value: 'ready' }

      const text = stringifyQuery({
        type: 'term',
        field: key,
        value: { kind: 'term', raw: 'ready' },
      })

      expect(engine.filter(text, [record])).toEqual([record])
    },
  )

  test('empty and duplicate exact field names fail with the configuration error', () => {
    expect(() => createQueryEngine({ fields: [{ ...field, key: '' }] })).toThrow(
      QueryConfigurationError,
    )
    expect(() => createQueryEngine({ fields: [field, field] })).toThrow(QueryConfigurationError)
  })

  test('an empty field list still permits an unconstrained empty query', () => {
    const engine = createQueryEngine<{ readonly value: string }>({ fields: [] })
    const record = { value: 'ready' }

    expect(engine.filter('', [record])).toEqual([record])
    expect(engine.filter('value:ready', [record])).toEqual([])
  })

  test('a mistyped JavaScript field fails at construction instead of matching silently', () => {
    // Without decoding, type: 'numeric' would be treated as analyzed text and return wrong rows.
    expect(() =>
      createQueryEngine(
        fieldsFromUntrusted({
          key: 'value',
          label: 'Value',
          type: 'numeric',
          read: (row: { value: number }) => row.value,
        }),
      ),
    ).toThrow(QueryConfigurationError)
  })

  test('every declared field type constructs and searches', () => {
    const typed = createQueryEngine(
      fieldsFromUntrusted({
        key: 'value',
        label: 'Value',
        type: 'date',
        read: (row: { value: string }) => row.value,
      }),
    )

    expect(typed.filter('value:[2026-01-01 TO 2026-12-31]', [{ value: '2026-10-24' }])).toEqual([
      { value: '2026-10-24' },
    ])
  })

  test.each([
    ['a non-string key', { key: 5, label: 'Value', type: 'keyword', read: (): string => 'x' }],
    ['a missing label', { key: 'value', type: 'keyword', read: (): string => 'x' }],
    [
      'non-string options',
      { key: 'value', label: 'Value', type: 'keyword', options: ['a', 2], read: (): string => 'x' },
    ],
    [
      'a non-boolean freeText',
      { key: 'value', label: 'Value', type: 'keyword', freeText: 'yes', read: (): string => 'x' },
    ],
  ])('rejects %s with the typed configuration error', (_reason, invalid) => {
    expect(() => createQueryEngine(fieldsFromUntrusted(invalid))).toThrow(QueryConfigurationError)
  })

  test('reports which field failed so the message is actionable', () => {
    const result = Effect.runSync(
      Effect.result(QueryEngine.make(fieldsFromUntrusted({ ...field, type: 'numeric' }))),
    )

    expect(Result.isFailure(result)).toBe(true)
    Result.match(result, {
      onSuccess: () => {
        throw new Error('Expected a configuration failure')
      },
      onFailure: (error) => {
        expect(error).toBeInstanceOf(QueryConfigurationError)
        expect(error.message).toContain('type')
      },
    })
  })
})
