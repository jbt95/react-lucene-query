import { describe, expect, test } from 'bun:test'
import { Data, Effect, Option, Result } from 'effect'
import {
  applySuggestion,
  hasErrors,
  InvalidQueryError,
  QueryEngine,
  QueryConfigurationError,
  type QueryField,
} from '../src/core'
import { createQueryEngine } from '../src/query-engine-adapter'
import { fields, records, type Shipment } from './fixtures'

const engine = Effect.runSync(QueryEngine.make({ fields, today: '2026-10-24' }))

const ids = (text: string) =>
  Effect.runSync(engine.filter(text, records)).map((record) => record.id)

describe('Lucene-style language', () => {
  test.each([
    ['', ['SHP-1042', 'SHP-1043', 'SHP-1044', 'SHP-1045']],
    ['status:ready AND units:>100', ['SHP-1042']],
    ['status:ready units:>100', ['SHP-1042']],
    ['status:delayed OR status:delivered', ['SHP-1043', 'SHP-1044']],
    ['NOT status:ready', ['SHP-1043', 'SHP-1044']],
    ['-status:ready', ['SHP-1043', 'SHP-1044']],
    ['(status:ready OR status:delayed) AND units:<100', ['SHP-1043', 'SHP-1045']],
    ['carrier:"North Star"', ['SHP-1042', 'SHP-1044']],
    ['carrier:No*', ['SHP-1042', 'SHP-1044']],
    ['"North Star"', ['SHP-1042', 'SHP-1044']],
    ['units:[35 TO 120]', ['SHP-1042', 'SHP-1043', 'SHP-1045']],
    ['status:(ready OR delayed)', ['SHP-1042', 'SHP-1043', 'SHP-1045']],
    ['active:true', ['SHP-1042', 'SHP-1043', 'SHP-1045']],
    ['due:[today TO today+1]', ['SHP-1042', 'SHP-1043']],
    ['due:24.10.2026', ['SHP-1042']],
    ['UNITS:>=1.2e2', ['SHP-1042', 'SHP-1044']],
    ['units:>-1', ['SHP-1042', 'SHP-1043', 'SHP-1044', 'SHP-1045']],
  ])('%s', (text, expected) => {
    expect(ids(text)).toEqual(expected)
  })

  test.each([
    'units:many',
    'active:maybe',
    'due:2026-02-30',
    'status:()',
    'status:(ready OR)',
    '(status:ready',
    'status:ready AND',
  ])('invalid: %s', (text) => {
    const result = Effect.runSync(Effect.result(engine.compile(text)))
    expect(Result.isFailure(result)).toBe(true)
    Result.match(result, {
      onSuccess: () => {
        throw new Error('Expected validation failure')
      },
      onFailure: (error) => {
        expect(error).toBeInstanceOf(InvalidQueryError)
        expect(error.diagnostics.length).toBeGreaterThan(0)
      },
    })
  })

  test('unknown fields are errors rather than silently ignored constraints', () => {
    const parsed = engine.parse('unuts:12')
    expect(parsed.diagnostics.some((item) => item.severity === 'error')).toBe(true)
  })

  test('input size, token, and depth budgets produce diagnostics, not stack overflow', () => {
    for (const text of [
      'x'.repeat(32769),
      'a '.repeat(4100),
      '('.repeat(101) + 'active:true' + ')'.repeat(101),
    ]) {
      expect(hasErrors(engine.parse(text))).toBe(true)
    }
  })

  test('independent negations do not count as nested recursion', () => {
    const text = Array.from({ length: 120 }, () => 'NOT active:false').join(' OR ')
    expect(hasErrors(engine.parse(text))).toBe(false)
  })

  test('wildcards remain literal and never use exponential regex backtracking', () => {
    expect(ids('carrier:*Star')).toEqual(['SHP-1042', 'SHP-1044'])
    expect(ids('carrier:N*th*S*r')).toEqual(['SHP-1042', 'SHP-1044'])
    expect(ids('carrier:North**Star')).toEqual(['SHP-1042', 'SHP-1044'])
    const hostile = 'carrier:' + 'a*'.repeat(100) + 'b'
    expect(ids(hostile)).toEqual([])
  })

  test('quotes and backslashes round-trip through completions', () => {
    const escaped: Shipment = { ...records[0]!, carrier: 'A "quoted" \\ carrier' }
    const list = Option.getOrThrow(engine.suggest('carrier:', 8, [escaped]))
    const item = list.items.find((entry) => entry.label === escaped.carrier)
    expect(item).toBeDefined()

    if (!item) return
    const next = applySuggestion('carrier:', list, item)
    expect(Effect.runSync(engine.filter(next.value, [escaped]))).toEqual([escaped])
  })
})

describe('plain consumer boundary', () => {
  test('ordinary consumers create and use an engine without Effect setup', () => {
    const plain = createQueryEngine({ fields, today: '2026-10-24' })
    expect(plain.filter('status:ready', records).map((record) => record.id)).toEqual([
      'SHP-1042',
      'SHP-1045',
    ])
    expect(plain.filter('units:invalid', records)).toEqual([])
    expect(plain.suggest('car', 3, records)?.items[0]?.id).toBe('field:carrier')
  })

  test('invalid plain configuration throws the domain error, not an Effect FiberFailure', () => {
    expect(() => createQueryEngine({ fields, today: 'not-a-date' })).toThrow(
      QueryConfigurationError,
    )
  })
})

describe('Effect execution boundary', () => {
  test('configuration errors are typed failures', () => {
    for (const options of [
      { fields, today: '2026-02-30' },
      { fields: [...fields, fields[0]!] },
      { fields: [{ ...fields[0]!, key: 'bad key' }] },
    ]) {
      const result = Effect.runSync(Effect.result(QueryEngine.make(options)))
      expect(Result.isFailure(result)).toBe(true)
      Result.match(result, {
        onSuccess: () => {
          throw new Error('Expected failure')
        },
        onFailure: (error) => expect(error).toBeInstanceOf(QueryConfigurationError),
      })
    }
  })

  test('backend adapter receives only valid parsed queries and retains typed errors', () => {
    class BackendError extends Data.TaggedError('BackendError')<{ readonly message: string }> {}

    let calls = 0

    const adapter = () => {
      calls += 1

      return Effect.fail(new BackendError({ message: 'offline' }))
    }

    const invalid = Effect.runSync(Effect.result(engine.search('units:many', adapter)))
    expect(calls).toBe(0)
    const valid = Effect.runSync(Effect.result(engine.search('units:5', adapter)))
    expect(calls).toBe(1)
    Result.match(invalid, {
      onSuccess: () => {
        throw new Error('Expected failure')
      },
      onFailure: (error) => expect(error).toBeInstanceOf(InvalidQueryError),
    })
    Result.match(valid, {
      onSuccess: () => {
        throw new Error('Expected failure')
      },
      onFailure: (error) => expect(error).toBeInstanceOf(BackendError),
    })
  })

  test('pure parsing stays tolerant; React adapter makes invalid applied predicates inert', () => {
    const reactEngine = createQueryEngine({ fields })
    expect(hasErrors(reactEngine.parse('units:many'))).toBe(true)
    expect(reactEngine.compile('units:many').test(records[0]!)).toBe(false)
  })
})

describe('completions', () => {
  test('prefix is based on caret and replacement preserves suffix', () => {
    const text = 'car AND active:true'
    const list = Option.getOrThrow(engine.suggest(text, 3, records))
    const item = list.items.find((entry) => entry.id === 'field:carrier')
    expect(item).toBeDefined()

    if (!item) return
    expect(applySuggestion(text, list, item).value).toBe('carrier: AND active:true')
  })

  test('record-value indexes are reused per immutable array', () => {
    let reads = 0

    const indexedFields: readonly QueryField<Shipment>[] = [
      {
        ...fields[1]!,
        read: (record) => {
          reads += 1

          return record.carrier
        },
      },
    ]

    const indexed = Effect.runSync(QueryEngine.make({ fields: indexedFields }))
    indexed.suggest('carrier:', 8, records)
    indexed.suggest('carrier:N', 9, records)
    expect(reads).toBe(records.length)
    indexed.suggest('carrier:', 8, [...records])
    expect(reads).toBe(records.length * 2)
  })
})
