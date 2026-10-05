import { describe, expect, test } from 'bun:test'
import {
  assertPortableFields,
  createWorkerEngine,
  handleRequest,
  isWorkerRequest,
  serveQueryWorker,
  type WorkerResponse,
  type WorkerScope,
} from '../src/worker'
import type { QueryField, SuggestionList } from '../src'

interface Part {
  readonly id: string
  readonly units: number
  readonly tags: readonly string[]
}

const parts: readonly [Part, Part] = [
  { id: 'bolt', units: 120, tags: ['metal'] },
  { id: 'nut', units: 5, tags: ['metal', 'small'] },
]

const pathFields: readonly QueryField<Part>[] = [
  { key: 'id', label: 'Id', type: 'keyword', freeText: true, path: 'id' },
  { key: 'units', label: 'Units', type: 'number', path: 'units' },
  { key: 'tags', label: 'Tags', type: 'keyword', path: 'tags' },
]

describe('portable field schemas', () => {
  test('a read accessor cannot be cloned into a worker', () => {
    expect(() =>
      assertPortableFields([
        { key: 'id', label: 'Id', type: 'keyword', read: (part: Part) => part.id },
      ]),
    ).toThrow(/need a path instead of read/)
  })

  test('a mixed schema names only the blocking field', () => {
    expect(() =>
      assertPortableFields([
        { key: 'id', label: 'Id', type: 'keyword', path: 'id' },
        { key: 'units', label: 'Units', type: 'number', read: (part: Part) => part.units },
      ]),
    ).toThrow(/units/)
  })

  test('a path-only schema constructs an engine', () => {
    const engine = createWorkerEngine({ fields: pathFields })

    expect(engine.filter('units:[100 TO 200]', parts)).toEqual([parts[0]])
    expect(engine.filter('tags:small', parts)).toEqual([parts[1]])
  })
})

describe('worker protocol', () => {
  const engine = createWorkerEngine({ fields: pathFields })

  test('filters with the same engine the main thread would use', () => {
    const response = handleRequest(
      { id: 1, type: 'filter', text: 'tags:metal', records: parts },
      engine,
    )

    expect(response).toEqual({ id: 1, ok: true, type: 'filter', matches: parts })
  })

  test('parses and reports diagnostics', () => {
    const response = handleRequest({ id: 2, type: 'parse', text: 'unites:5' }, engine)

    expect(response.ok && response.type === 'parse' ? response.parsed : 'missing').toMatchObject({
      diagnostics: [{ severity: 'warning' }],
    })
  })

  test('suggests values counted from the supplied records', () => {
    const response = handleRequest(
      { id: 3, type: 'suggest', text: 'tags:', caret: 5, records: parts },
      engine,
    )

    // SAFETY: the worker's own engine produced this payload from the call it was sent.
    const list = (response.ok && response.type === 'suggest' ? response.suggestions : undefined) as
      | SuggestionList
      | undefined

    expect(list?.items.map((item) => item.label)).toContain('metal')
  })

  test('lists clauses for chips', () => {
    const response = handleRequest({ id: 4, type: 'clauses', text: 'id:bolt' }, engine)

    expect(response.ok && response.type === 'clauses' ? response.clauses : undefined).toEqual([
      { field: 'id', value: { kind: 'term', raw: 'bolt' }, occur: 'should', text: 'id:bolt' },
    ])
  })

  test('an invalid query is reported, not thrown across the port', () => {
    const response = handleRequest(
      { id: 5, type: 'filter', text: 'units:[a TO', records: parts },
      engine,
    )

    expect(response.ok).toBe(false)
    expect(response.ok ? '' : response.error.length > 0).toBe(true)
  })

  test('an id is always echoed so a reply cannot be mistaken for another', () => {
    const response = handleRequest({ id: 99, type: 'parse', text: '' }, engine)

    expect(response.id).toBe(99)
  })
})

describe('message decoding', () => {
  const rejects: readonly unknown[] = [
    'not an object',
    null,
    { id: 1, type: 'filter', text: 'id:bolt' }, // filter requires records
    { id: 1, type: 'filter', records: [] }, // filter requires text
    { id: 'one', type: 'parse', text: '' }, // id must be a number
    { id: 1, type: 'parse', text: '', extra: true }, // strict: excess keys are a typo
    { id: 1, type: 'suggest', text: '', caret: 'x' }, // caret must be a number
    { id: 1, type: 'parse', text: '', matches: [] }, // two payloads in one message
  ]

  test.each(rejects.map((message) => [JSON.stringify(message), message] as const))(
    'refuses %s at the decode seam',
    (_label, message) => {
      expect(isWorkerRequest(message)).toBe(false)
    },
  )

  test.each([
    [{ id: 1, type: 'parse', text: '' }],
    [{ id: 1, type: 'clauses', text: '' }],
    [{ id: 1, type: 'filter', text: '', records: [] }],
    [{ id: 1, type: 'suggest', text: '', caret: 0 }],
  ] as const)('accepts a well-formed %s', (message) => {
    expect(isWorkerRequest(message)).toBe(true)
  })
})

describe('serveQueryWorker', () => {
  /**
   * A port the test drives with a real `MessageEvent`, so the decode runs exactly as it does in a
   * worker. `MessageEventInit['data']` is the type lib.dom gives `event.data`, which is whatever
   * was posted — the malformed cases below depend on that being unconstrained.
   */
  const scopeFor = () => {
    const replies: WorkerResponse[] = []
    let listener: ((event: MessageEvent) => void) | undefined

    const scope: WorkerScope = {
      postMessage: (message) => replies.push(message),
      addEventListener: (_type, next) => {
        listener = next
      },
    }

    const post = (data: MessageEventInit['data']) =>
      listener?.(new MessageEvent('message', { data }))

    return { replies, scope, post }
  }

  test('a refused message is answered with the id it carried', () => {
    const { replies, scope, post } = scopeFor()

    serveQueryWorker(createWorkerEngine({ fields: pathFields }), scope)
    post({ id: 12, type: 'nope', text: '' })

    expect(replies).toEqual([
      { id: 12, ok: false, error: expect.stringContaining('Not a query worker message') },
    ])
  })

  test('a message with no readable id is marked unattributable', () => {
    const { replies, scope, post } = scopeFor()

    serveQueryWorker(createWorkerEngine({ fields: pathFields }), scope)
    post({ type: 'parse' })

    expect(replies[0]?.id).toBe(-1)
  })

  test('answers every message posted to the scope', () => {
    const { replies, scope, post } = scopeFor()

    serveQueryWorker(createWorkerEngine({ fields: pathFields }), scope)
    post({ id: 7, type: 'filter', text: 'id:nut', records: parts })

    expect(replies).toEqual([{ id: 7, ok: true, type: 'filter', matches: [parts[1]] }])
  })
})
