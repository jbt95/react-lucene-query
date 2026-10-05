import { describe, expect, test } from 'bun:test'
import {
  createQueryWorkerSearch,
  createWorkerEngine,
  handleRequest,
  serveQueryWorker,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerScope,
} from '../src/worker'
import type { QueryField } from '../src/core'

const fields: readonly QueryField<{ readonly id: string }>[] = [
  { key: 'id', label: 'Identifier', type: 'keyword', path: 'id', options: ['a', 'b'] },
]

const engine = createWorkerEngine({ fields })

class QueryTestWorker extends EventTarget {
  readonly requests: WorkerRequest[] = []
  terminated = false

  constructor(readonly autoReply = true) {
    super()
  }

  postMessage(request: WorkerRequest): void {
    this.requests.push(request)

    if (this.autoReply && request.type !== 'initialize') {
      const response = structuredClone(handleRequest(request, engine))
      queueMicrotask(() => this.reply(response))
    }
  }

  reply(response: WorkerResponse): void {
    this.dispatchEvent(new MessageEvent('message', { data: response }))
  }

  terminate(): void {
    this.terminated = true
  }
}

describe('query worker client', () => {
  test('no suggestion result resolves undefined instead of throwing', async () => {
    const worker = new QueryTestWorker()
    const client = createQueryWorkerSearch({ fields, worker })

    try {
      expect(await client.suggest('id:[', 4)).toBeUndefined()
      expect((await client.suggest('id:', 3))?.items.map((item) => item.label)).toContain('a')
    } finally {
      client.terminate()
    }
  })

  test('an omitted no-suggestion payload is still a successful response', async () => {
    const worker = new QueryTestWorker(false)
    const client = createQueryWorkerSearch({ fields, worker })
    const suggestion = client.suggest('id:[', 4)
    await Promise.resolve()
    expect(worker.requests).toHaveLength(1)
    worker.reply({ id: worker.requests[0]?.id ?? 0, ok: true, type: 'suggest' })
    expect(await suggestion).toBeUndefined()
    client.terminate()
  })

  test('filters, parses, and lists clauses over structured-cloned responses', async () => {
    const worker = new QueryTestWorker()
    const client = createQueryWorkerSearch({ fields, worker })

    try {
      expect(await client.filter('id:a', [{ id: 'a' }, { id: 'b' }])).toEqual([{ id: 'a' }])
      expect((await client.parse('id:a')).diagnostics).toEqual([])
      expect((await client.clauses('id:a')).map((clause) => clause.text)).toEqual(['id:a'])
    } finally {
      client.terminate()
    }
  })

  test('a response must match the request type, not just its id', async () => {
    const worker = new QueryTestWorker(false)
    const client = createQueryWorkerSearch({ fields, worker })
    const pending = client.suggest('id:', 3).catch((error: Error) => error)
    await Promise.resolve()
    expect(worker.requests).toHaveLength(1)
    worker.reply({ id: worker.requests[0]?.id ?? 0, ok: true, type: 'filter', matches: [] })
    expect(await pending).toEqual(new Error('Unexpected query worker response for suggest'))
    client.terminate()
  })

  test('out-of-order answers resolve their own request', async () => {
    const worker = new QueryTestWorker(false)
    const client = createQueryWorkerSearch({ fields, worker })
    const first = client.filter('id:a', [{ id: 'a' }])
    const second = client.filter('id:b', [{ id: 'b' }])
    await Promise.resolve()
    worker.reply({
      id: worker.requests[1]?.id ?? 0,
      ok: true,
      type: 'filter',
      matches: [{ id: 'b' }],
    })
    worker.reply({
      id: worker.requests[0]?.id ?? 0,
      ok: true,
      type: 'filter',
      matches: [{ id: 'a' }],
    })
    expect(await first).toEqual([{ id: 'a' }])
    expect(await second).toEqual([{ id: 'b' }])
    client.terminate()
  })

  test.each(['error', 'messageerror'])(
    '%s rejects outstanding and future requests',
    async (type) => {
      const worker = new QueryTestWorker(false)
      const client = createQueryWorkerSearch({ fields, worker })
      const first = client.parse('id:a').catch((error: Error) => error)
      const second = client.filter('id:a', []).catch((error: Error) => error)
      await Promise.resolve()
      worker.dispatchEvent(
        type === 'error'
          ? new ErrorEvent('error', { message: 'failed to load' })
          : new MessageEvent('messageerror'),
      )
      expect(await first).toBeInstanceOf(Error)
      expect(await second).toBeInstanceOf(Error)
      await expect(client.parse('')).rejects.toThrow()
      client.terminate()
    },
  )

  test('termination rejects outstanding and future requests', async () => {
    const worker = new QueryTestWorker(false)
    const client = createQueryWorkerSearch({ fields, worker })
    const first = client.parse('').catch((error: Error) => error)
    await Promise.resolve()
    client.terminate()
    expect(await first).toEqual(new Error('The query worker was terminated'))
    await expect(client.parse('')).rejects.toThrow('terminated')
    expect(worker.terminated).toBe(true)
  })
})

describe('default worker initialization', () => {
  function initializedScope() {
    const responses: WorkerResponse[] = []
    let receive: ((event: MessageEvent) => void) | undefined

    const scope: WorkerScope = {
      postMessage: (response) => {
        responses.push(response)
      },
      addEventListener: (_type, listener) => {
        receive = listener
      },
    }

    serveQueryWorker(undefined, scope)

    return {
      responses,
      post: (request: WorkerRequest) =>
        receive?.(new MessageEvent('message', { data: structuredClone(request) })),
    }
  }

  test('portable fields, suggestion options, and unknown-field policy reach the engine', () => {
    const worker = initializedScope()
    worker.post({
      id: 1,
      type: 'initialize',
      fields: [
        {
          key: 'id',
          label: 'Identifier',
          type: 'keyword',
          path: 'id',
          freeText: true,
          options: ['a', 'b'],
        },
      ],
      unknownFields: 'error',
    })
    worker.post({ id: 2, type: 'filter', text: 'a', records: [{ id: 'a' }, { id: 'b' }] })
    worker.post({ id: 3, type: 'suggest', text: 'id:', caret: 3 })
    worker.post({ id: 4, type: 'filter', text: 'unknown:a', records: [] })

    expect(worker.responses[0]).toEqual({ id: 1, ok: true, type: 'initialize' })
    expect(worker.responses[1]).toEqual({ id: 2, ok: true, type: 'filter', matches: [{ id: 'a' }] })
    expect(worker.responses[2]).toMatchObject({
      ok: true,
      type: 'suggest',
      suggestions: { items: expect.arrayContaining([expect.objectContaining({ label: 'a' })]) },
    })
    expect(worker.responses[3]).toMatchObject({ id: 4, ok: false })
  })

  test('queries before initialization and invalid configurations are answered with failures', () => {
    const worker = initializedScope()
    worker.post({ id: 1, type: 'parse', text: '' })
    worker.post({
      id: 2,
      type: 'initialize',
      fields: [{ key: 'id', label: 'Identifier', type: 'keyword', path: '' }],
    })

    expect(worker.responses).toEqual([
      { id: 1, ok: false, error: expect.stringContaining('not initialized') },
      { id: 2, ok: false, error: expect.stringContaining('exactly one') },
    ])
  })

  test('default construction rejects custom analyzers before spawning an unclonable worker', () => {
    expect(() =>
      createQueryWorkerSearch({
        fields: [
          { key: 'id', label: 'Identifier', type: 'text', path: 'id', analyze: (text) => [text] },
        ],
      }),
    ).toThrow('configured worker')
  })
})
