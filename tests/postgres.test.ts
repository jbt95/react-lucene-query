import { describe, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'
import { QueryEngine, parseQuery, type QueryField } from '../src/core'
import { QueryTranslationError, toPostgres, type PostgresOptions } from '../src/postgres'
import {
  outputFields,
  postgresOptions,
  postgresParityQueries,
  type OutputRecord,
} from './output-fixtures'

const parsed = (text: string) => parseQuery(text, outputFields)

const translate = (text: string, options: PostgresOptions<OutputRecord> = postgresOptions) =>
  Result.getOrThrow(toPostgres(parsed(text), options))

describe('PostgreSQL query output', () => {
  test('keyword equality and numeric ranges produce a condition with bound parameters', () => {
    expect(translate('status:ready AND units:[100 TO 200]')).toEqual({
      sql: '(COALESCE("status" COLLATE "C" = $1::text, FALSE) AND COALESCE(("units" >= $2::double precision AND "units" <= $3::double precision), FALSE))',
      params: ['ready', 100, 200],
    })
  })

  test('empty and match-all queries need no parameters', () => {
    expect(translate('')).toEqual({ sql: 'TRUE', params: [] })
    expect(translate('*:*')).toEqual({ sql: 'TRUE', params: [] })
  })

  test('unqualified input expands configured free-text fields', () => {
    expect(translate('ready').params).toEqual(['ready'])
    expect(translate('ready', { ...postgresOptions, fields: [] })).toEqual({
      sql: 'FALSE',
      params: [],
    })
  })

  test.each(['NOT status:ready', '-status:ready', 'NOT status:ready AND NOT units:100'])(
    'pure prohibited groups match nothing: %s',
    (text) => {
      expect(translate(text)).toEqual({ sql: 'FALSE', params: [] })
    },
  )

  test('unknown fields and unmatchable numeric/date values preserve match-none semantics', () => {
    for (const text of [
      'missing:ready',
      'units:many',
      'units:[many TO 100]',
      'due:wrong',
      'due:2026-02-30',
      'status:""',
    ]) {
      expect(translate(text)).toEqual({ sql: 'FALSE', params: [] })
    }
  })

  test('NULL-safe negation includes missing scalar values', () => {
    expect(translate('*:* AND NOT status:ready')).toEqual({
      sql: '(TRUE AND NOT (COALESCE("status" COLLATE "C" = $1::text, FALSE)))',
      params: ['ready'],
    })
  })

  test('optional clauses with required clauses leave no unused bindings', () => {
    expect(translate('+status:ready units:200').params).toEqual(['ready'])
    expect(translate('units:200 +status:ready').params).toEqual(['ready'])
    expect(translate('(+status:ready units:200) OR status:READY').params).toEqual([
      'ready',
      'READY',
    ])
  })

  test('date terms and ranges use half-open UTC windows', () => {
    expect(translate('due:2026-10').params).toEqual([
      '2026-10-01T00:00:00.000Z',
      '2026-11-01T00:00:00.000Z',
    ])
    expect(translate('due:{2026-10-01 TO 2026-10-24}').params).toEqual([
      '2026-10-02T00:00:00.000Z',
      '2026-10-24T00:00:00.000Z',
    ])
    expect(translate('due:"2026-10-24T14:00+02:00"').params).toEqual([
      '2026-10-24T12:00:00.000Z',
      '2026-10-24T12:00:01.000Z',
    ])
    expect(translate('due:9999').params).toEqual([
      '9999-01-01T00:00:00.000Z',
      '10000-01-01T00:00:00.000Z',
    ])
  })

  test('open numeric/date ranges still exclude NULL', () => {
    expect(translate('units:[* TO *]').sql).toBe('"units" IS NOT NULL')
    expect(translate('due:[* TO *]').sql).toBe('"due" IS NOT NULL')
  })

  test('query values never become SQL source', () => {
    const value = "x' OR TRUE --"
    const query = translate('status:"' + value + '"')
    expect(query.params).toEqual([value])
    expect(query.sql.includes(value)).toBe(false)
  })

  test('well-formed supplementary Unicode remains supported', () => {
    expect(translate('status:"👍"').params).toEqual(['👍'])
    expect(
      translate('status:ready', {
        ...postgresOptions,
        columns: { status: { column: '👍'.repeat(15), type: 'text' } },
      }).params,
    ).toEqual(['ready'])
  })

  test('qualification, quote escaping, and dollar-like identifier text are safe', () => {
    const query = translate('status:ready AND units:100', {
      ...postgresOptions,
      columns: {
        ...postgresOptions.columns,
        status: { column: ['orders', 'sta"$1tus'], type: 'text' },
      },
    })

    expect(query.sql).toContain('"orders"."sta""$1tus" COLLATE "C" = $1::text')
    expect(query.sql).toContain('"units" = $2::double precision')
    expect(query.params).toEqual(['ready', 100])
  })

  test.each([
    'status:rea*',
    'status:ready~',
    'status:/ready/',
    'status:"ready"~0',
    'status:[a TO z]',
    'status:ready^2',
    '(status:ready OR status:delayed)^2',
    '+status:ready units:20*',
    'units:20*',
    'due:2026*',
  ])('unsupported features are errors even in optional clauses: %s', (text) => {
    const result = toPostgres(parsed(text), postgresOptions)
    expect(Result.isFailure(result) && result.failure.code).toBe('unsupported-feature')
  })

  test('analyzed text is rejected, including unqualified expansion', () => {
    const fields: readonly QueryField<OutputRecord>[] = [
      { key: 'status', label: 'Status', type: 'text', path: 'status', freeText: true },
    ]

    for (const text of ['status:ready', 'ready']) {
      const result = toPostgres(parseQuery(text, fields), { ...postgresOptions, fields })
      expect(Result.isFailure(result) && result.failure.feature).toBe('text analysis')
    }
  })

  test('invalid drafts are never translated from their partial trees', () => {
    const result = toPostgres(parsed('status:ready AND'), postgresOptions)
    expect(Result.isFailure(result) && result.failure.code).toBe('invalid-query')
  })

  test('missing, incompatible, and invalid column mappings fail explicitly', () => {
    const mappings: readonly PostgresOptions<OutputRecord>['columns'][] = [
      {},
      { status: { column: 'status', type: 'number' as const } },
      { status: { column: '', type: 'text' as const } },
      { status: { column: [], type: 'text' as const } },
      { status: { column: ['status', ''], type: 'text' as const } },
      { status: { column: 'x'.repeat(64), type: 'text' as const } },
      { status: { column: 'stat\0us', type: 'text' as const } },
      { status: { column: 'stat\uD800us', type: 'text' as const } },
      { status: { column: '👍'.repeat(16), type: 'text' as const } },
    ]

    for (const columns of mappings) {
      expect(
        Result.isFailure(toPostgres(parsed('status:ready'), { ...postgresOptions, columns })),
      ).toBe(true)
    }
  })

  test('column qualification accepts four segments and rejects five', () => {
    const supported = translate('status:ready', {
      ...postgresOptions,
      columns: { status: { column: ['catalog', 'schema', 'orders', 'status'], type: 'text' } },
    })

    expect(supported.sql).toContain('"catalog"."schema"."orders"."status"')

    const result = toPostgres(parsed('status:ready'), {
      ...postgresOptions,
      columns: {
        status: { column: ['catalog', 'schema', 'orders', 'status', 'extra'], type: 'text' },
      },
    })

    expect(Result.isFailure(result) && result.failure.code).toBe('invalid-mapping')
  })

  test('inherited object properties cannot act as column mappings', () => {
    const result = toPostgres(parsed('status:ready'), {
      ...postgresOptions,
      columns: Object.create({ status: { column: 'status', type: 'text' } }),
    })

    expect(Result.isFailure(result) && result.failure.code).toBe('unmapped-field')
  })

  test.each(['units:Infinity', 'units:1e999', 'due:0000', 'status:"a\0b"', 'status:"a\uD800b"'])(
    'unrepresentable PostgreSQL values fail explicitly: %s',
    (text) => {
      const result = toPostgres(parsed(text), postgresOptions)
      expect(Result.isFailure(result) && result.failure.code).toBe('invalid-value')
    },
  )

  test.each([...postgresParityQueries])('supported parity corpus translates: %s', (text) => {
    const query = translate(text)
    expect(query.sql.length).toBeGreaterThan(0)
  })

  test('the existing Effect execution seam can return SQL and retain translation failures', () => {
    const engine = Effect.runSync(QueryEngine.make({ fields: outputFields }))

    const adapter = (query: ReturnType<typeof parsed>) =>
      Effect.fromResult(toPostgres(query, postgresOptions))

    expect(Effect.runSync(engine.search('status:ready', adapter)).params).toEqual(['ready'])

    const result = Effect.runSync(Effect.result(engine.search('status:rea*', adapter)))
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(QueryTranslationError)
  })
})
