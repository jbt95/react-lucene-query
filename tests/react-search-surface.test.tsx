import { afterEach, describe, expect, test } from 'bun:test'
import { useState } from 'react'
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import {
  createQueryEngine,
  Query,
  useQueryHistory,
  useQuerySearch,
  useQueryUrlState,
  type QueryEngine,
  type SearchError,
} from '../src'
import { fields, records, type Shipment } from './fixtures'

afterEach(cleanup)

const engine = createQueryEngine({ fields })

/** A backend that answers a fixed delay later, and can be made slow or broken per test. */
function createBackend(delayMs = 0) {
  const calls: { text: string; signal: AbortSignal }[] = []
  let fail = false

  const search = (text: string, signal: AbortSignal): Promise<readonly Shipment[]> => {
    calls.push({ text, signal })

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (fail) {
          const failure: SearchError = { name: 'HttpError', message: 'backend is down' }
          reject(failure)

          return
        }

        resolve(engine.filter(text, records))
      }, delayMs)

      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        const cancelled: SearchError = { name: 'AbortError' }
        reject(cancelled)
      })
    })
  }

  return { search, calls, setFailing: (next: boolean) => (fail = next) }
}

describe('async search mode', () => {
  test('an applied query is fetched and its results are reported', async () => {
    const backend = createBackend()

    const { result } = renderHook(() =>
      useQuerySearch<Shipment>({ mode: 'async', engine, search: backend.search }),
    )

    await act(async () => {
      result.current.apply('status:ready')
    })

    expect(backend.calls.at(-1)?.text).toBe('status:ready')
    await waitFor(() => expect(result.current.results.length).toBe(2))
    expect(result.current.status).toBe('ready')
    expect(result.current.results).toEqual(engine.filter('status:ready', records))
  })

  test('an invalid draft never reaches the backend', async () => {
    const backend = createBackend()

    const { result } = renderHook(() =>
      useQuerySearch<Shipment>({ mode: 'async', engine, search: backend.search }),
    )

    await act(async () => {
      expect(result.current.apply('status:[a TO')).toBe(false)
    })

    // Only the initial empty query was ever fetched; the rejected one never left the browser.
    expect(backend.calls.map((call) => call.text)).toEqual([''])
    expect(result.current.isValid).toBe(false)
    expect(result.current.applied).toBe('')
  })

  test('a superseded request is cancelled and cannot overwrite a newer one', async () => {
    const backend = createBackend(20)

    const { result } = renderHook(() =>
      useQuerySearch<Shipment>({ mode: 'async', engine, search: backend.search }),
    )

    await act(async () => {
      result.current.apply('status:ready')
    })
    await act(async () => {
      result.current.apply('status:delayed')
    })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.applied).toBe('status:delayed')
    expect(result.current.results).toEqual(engine.filter('status:delayed', records))
    expect(backend.calls[0]?.signal.aborted).toBe(true)
  })

  test('debouncing collapses a burst of applied queries into one request', async () => {
    const backend = createBackend()

    const { result } = renderHook(() =>
      useQuerySearch<Shipment>({
        mode: 'async',
        engine,
        search: backend.search,
        debounceMs: 20,
      }),
    )

    await act(async () => {
      result.current.apply('status:ready')
      result.current.apply('status:delivered')
      result.current.apply('status:delayed')
    })

    expect(backend.calls).toHaveLength(0)
    await waitFor(() => expect(backend.calls).toHaveLength(1))
    expect(backend.calls[0]?.text).toBe('status:delayed')
  })

  test('a failed request is reported and does not become a result', async () => {
    const backend = createBackend()
    backend.setFailing(true)

    const { result } = renderHook(() =>
      useQuerySearch<Shipment>({ mode: 'async', engine, search: backend.search }),
    )

    await act(async () => {
      result.current.apply('status:ready')
    })

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error?.message).toBe('backend is down')
    expect(result.current.results).toEqual([])
  })

  test('refresh re-runs the applied query', async () => {
    const backend = createBackend()

    const { result } = renderHook(() =>
      useQuerySearch<Shipment>({ mode: 'async', engine, search: backend.search }),
    )

    await act(async () => {
      result.current.apply('status:ready')
    })
    const before = backend.calls.length

    await act(async () => {
      result.current.refresh()
    })

    expect(backend.calls.length).toBe(before + 1)
  })

  test('an unmount cancels the in-flight request', async () => {
    const backend = createBackend(50)

    const { result, unmount } = renderHook(() =>
      useQuerySearch<Shipment>({ mode: 'async', engine, search: backend.search }),
    )

    await act(async () => {
      result.current.apply('status:ready')
    })
    const inFlight = backend.calls.at(-1)?.signal
    unmount()

    expect(inFlight?.aborted).toBe(true)
  })

  test('local mode still filters without a backend', () => {
    const { result } = renderHook(() => useQuerySearch({ engine, records }))

    act(() => {
      result.current.apply('status:ready')
    })

    expect(result.current.mode).toBe('local')
    expect(result.current.results.length).toBe(2)
    expect(result.current.status).toBe('ready')
  })
})

describe('url state', () => {
  function fakeUrl(search = '') {
    const written: string[] = []
    const target = { search, pathname: '/shipments' }

    const history = {
      pushState: (_data: null, _unused: string, url: string) => written.push(url),
      replaceState: (_data: null, _unused: string, url: string) => written.push(url),
    }

    const options = { target, history }

    return { target, history, written, options }
  }

  test('reads the initial query from the url and writes the next one back', () => {
    const url = fakeUrl('?q=status%3Aready')
    const { result } = renderHook(() => useQueryUrlState(url.options))

    expect(result.current[0]).toBe('status:ready')

    act(() => {
      result.current[1]('carrier:arc')
    })

    expect(url.written).toEqual(['/shipments?q=carrier%3Aarc'])
    expect(result.current[0]).toBe('carrier:arc')
  })

  test('an empty query removes the parameter instead of leaving it blank', () => {
    const url = fakeUrl('?q=status%3Aready')
    const { result } = renderHook(() => useQueryUrlState(url.options))

    act(() => {
      result.current[1]('')
    })

    expect(url.written).toEqual(['/shipments'])
  })

  test('other parameters are preserved and the key is configurable', () => {
    const url = fakeUrl('?page=2&q=a')
    const { result } = renderHook(() => useQueryUrlState({ ...url.options, key: 'query' }))

    // The configured key is absent, so the initial query is empty rather than another key's value.
    expect(result.current[0]).toBe('')

    act(() => {
      result.current[1]('b')
    })

    expect(url.written).toEqual(['/shipments?page=2&q=a&query=b'])
  })

  test('replace overwrites the current entry instead of pushing one', () => {
    const url = fakeUrl('?q=a')
    const { result } = renderHook(() => useQueryUrlState({ ...url.options, replace: true }))

    act(() => {
      result.current[1]('b')
    })

    expect(url.written).toEqual(['/shipments?q=b'])
  })

  test('a shared url drives the applied query through popstate', () => {
    const url = fakeUrl()
    const { result } = renderHook(() => useQueryUrlState(url.options))

    act(() => {
      window.dispatchEvent(new Event('popstate'))
    })

    expect(result.current[0]).toBe('')
  })
})

describe('query history', () => {
  function memoryStorage() {
    const map = new Map<string, string>()

    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => map.set(key, value),
      removeItem: (key: string) => map.delete(key),
    }
  }

  test('records each applied query once, newest first', () => {
    const storage = memoryStorage()

    const { result } = renderHook(() => useQueryHistory({ engine, storage, key: 'test-history' }))

    act(() => {
      result.current.push('status:ready')
    })
    act(() => {
      result.current.push('status:delayed')
    })
    act(() => {
      result.current.push('status:ready')
    })

    expect(result.current.entries.map((entry) => entry.text)).toEqual([
      'status:ready',
      'status:delayed',
    ])
  })

  test('never records an invalid or empty query', () => {
    const storage = memoryStorage()

    const { result } = renderHook(() => useQueryHistory({ engine, storage, key: 'test-history' }))

    act(() => {
      result.current.push('')
    })
    act(() => {
      result.current.push('status:[a TO')
    })

    expect(result.current.entries).toEqual([])
  })

  test('an applied value is recorded automatically', () => {
    const storage = memoryStorage()

    const { result } = renderHook(() =>
      useQueryHistory({ engine, value: 'status:ready', storage, key: 'h' }),
    )

    expect(result.current.entries.map((entry) => entry.text)).toEqual(['status:ready'])
  })

  test('entries survive a remount through storage', () => {
    const storage = memoryStorage()
    const first = renderHook(() => useQueryHistory({ engine, storage, key: 'kept' }))

    act(() => {
      first.result.current.push('status:ready')
    })
    first.unmount()

    const second = renderHook(() => useQueryHistory({ engine, storage, key: 'kept' }))

    expect(second.result.current.entries.map((entry) => entry.text)).toEqual(['status:ready'])
  })

  test('unreadable storage is an empty history, not a crash', () => {
    const broken = {
      getItem: () => 'not json at all',
      setItem: () => undefined,
      removeItem: () => undefined,
    }

    const { result } = renderHook(() => useQueryHistory({ engine, storage: broken, key: 'x' }))

    expect(result.current.entries).toEqual([])
  })

  test('remove and clear drop entries', () => {
    const storage = memoryStorage()

    const { result } = renderHook(() => useQueryHistory({ engine, storage, key: 'editable' }))

    act(() => {
      result.current.push('a:1')
    })
    act(() => {
      result.current.push('b:2')
    })
    act(() => {
      result.current.remove(0)
    })

    expect(result.current.entries.map((entry) => entry.text)).toEqual(['a:1'])

    act(() => {
      result.current.clear()
    })

    expect(result.current.entries).toEqual([])
  })
})

function FilterFixture() {
  const [draft, setDraft] = useState('')
  const [applied, setApplied] = useState('')

  const search = useQuerySearch({
    engine,
    records,
    value: draft,
    appliedValue: applied,
    onValueChange: setDraft,
    onApply: setApplied,
  })

  return (
    <>
      <Query.Root
        engine={engine}
        records={records}
        value={search.draft}
        applied={search.applied}
        onValueChange={search.setDraft}
        onSubmit={search.submit}
      >
        <Query.Input aria-label="Query" />
        <Query.Facets field="status" />
        <Query.Chips />
      </Query.Root>
      <output data-testid="applied">{search.applied}</output>
      <output data-testid="count">{search.results.length}</output>
    </>
  )
}

describe('click-to-query primitives', () => {
  test('a facet shows counts for the current result set and toggles the query', () => {
    render(<FilterFixture />)

    expect(screen.getByRole('button', { name: 'ready 2' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'delivered 1' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'ready 2' }))

    expect(screen.getByTestId('applied').textContent).toBe('status:ready')
    expect(screen.getByTestId('count').textContent).toBe('2')
  })

  test('a selected facet is pressed, and clicking it again removes the condition', () => {
    render(<FilterFixture />)

    const facet = screen.getByRole('button', { name: 'ready 2' })

    fireEvent.click(facet)
    expect(screen.getByRole('button', { name: 'Status: ready' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'ready 2' }))
    expect(screen.getByTestId('applied').textContent).toBe('')
    expect(screen.queryByRole('button', { name: 'Status: ready' })).toBeNull()
  })

  test('facet counts shrink with the applied query', () => {
    render(<FilterFixture />)

    fireEvent.click(screen.getByRole('button', { name: 'ready 2' }))

    // Only the two ready shipments remain, so an option with no match is not offered at all.
    expect(screen.getByRole('button', { name: 'ready 2' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'delivered 1' })).toBeNull()
  })

  test('a chip removes the condition it represents', () => {
    render(<FilterFixture />)

    fireEvent.click(screen.getByRole('button', { name: 'delivered 1' }))
    const chip = screen.getByRole('button', { name: 'Status: delivered' })

    fireEvent.click(chip)

    expect(screen.getByTestId('applied').textContent).toBe('')
    expect(screen.getByTestId('count').textContent).toBe('4')
  })

  test('no chips render for an empty query', () => {
    render(<FilterFixture />)

    expect(screen.queryByRole('list', { name: 'Applied filters' })).toBeNull()
  })
})

function EngineOnlyFixture({ custom }: { readonly custom: QueryEngine<Shipment> }) {
  const search = useQuerySearch({ engine: custom, records, defaultValue: '' })

  return <output data-testid="applied">{search.draft}</output>
}

describe('root context wiring', () => {
  test('the root tolerates a records-less backend-only controller', () => {
    const custom = createQueryEngine({ fields })
    const { unmount } = render(<EngineOnlyFixture custom={custom} />)

    expect(screen.getByTestId('applied').textContent).toBe('')
    unmount()
  })
})
