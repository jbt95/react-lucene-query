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
import { createQueryEngine, Query, useQueryHistory, useQuerySearch, useQueryUrlState } from '../src'
import { fields, records, type Shipment } from './fixtures'

afterEach(cleanup)

const engine = createQueryEngine({ fields })

function deferredResults() {
  let settle: ((value: readonly Shipment[]) => void) | undefined

  const promise = new Promise<readonly Shipment[]>((resolve) => {
    settle = resolve
  })

  return { promise, resolve: (value: readonly Shipment[]) => settle?.(value) }
}

describe('async request ownership', () => {
  test('an inline callback fetches once, not again after results or unrelated renders', async () => {
    let calls = 0

    const { result, rerender } = renderHook(() =>
      useQuerySearch({
        mode: 'async',
        engine,
        search: () => {
          calls += 1

          // Keep a regressed implementation from spinning forever in the test.
          return calls > 4 ? new Promise<readonly Shipment[]>(() => {}) : Promise.resolve(records)
        },
      }),
    )

    await waitFor(() => expect(result.current.status).toBe('ready'))
    rerender()
    await act(async () => {})
    expect(calls).toBe(1)
  })

  test('an invalid initially applied query never reaches the backend', async () => {
    let calls = 0

    const search = () => {
      calls += 1

      return Promise.resolve(records)
    }

    const { result } = renderHook(() =>
      useQuerySearch({
        mode: 'async',
        engine,
        search,
        defaultAppliedValue: 'status:[ready TO',
      }),
    )

    await act(async () => {})
    expect(calls).toBe(0)
    expect(result.current.status).toBe('ready')
    expect(result.current.results).toEqual([])
    expect(result.current.parsedApplied.diagnostics).not.toEqual([])
  })

  test('the latest callback is used by the next query or refresh, without identity refetches', async () => {
    const calls: string[] = []

    const { result, rerender } = renderHook(
      ({ version }) =>
        useQuerySearch({
          mode: 'async',
          engine,
          search: (text) => {
            calls.push(`${version}:${text}`)

            return Promise.resolve(records)
          },
        }),
      { initialProps: { version: 'first' } },
    )

    await waitFor(() => expect(result.current.status).toBe('ready'))
    rerender({ version: 'second' })
    await act(async () => {})
    expect(calls).toEqual(['first:'])

    await act(async () => {
      result.current.apply('status:ready')
    })
    expect(calls).toEqual(['first:', 'second:status:ready'])

    await act(async () => {
      result.current.refresh()
    })
    expect(calls).toEqual(['first:', 'second:status:ready', 'second:status:ready'])
  })

  test('a retry starts loading and a successful answer replaces the old error', async () => {
    const retry = deferredResults()
    let calls = 0

    const search = () => {
      calls += 1

      return calls === 1 ? Promise.reject({ name: 'HttpError', message: 'down' }) : retry.promise
    }

    const { result } = renderHook(() => useQuerySearch({ mode: 'async', engine, search }))

    await waitFor(() => expect(result.current.status).toBe('error'))
    act(() => result.current.refresh())
    expect(result.current.status).toBe('loading')
    expect(result.current.error).toBeUndefined()
    expect(result.current.results).toEqual([])

    await act(async () => {
      retry.resolve(records)
    })
    expect(result.current.status).toBe('ready')
    expect(result.current.error).toBeUndefined()
    expect(result.current.results).toEqual(records)
  })

  test('a failed refresh cannot coexist with a previous successful result', async () => {
    let calls = 0

    const search = () =>
      ++calls === 1
        ? Promise.resolve(records)
        : Promise.reject({ name: 'HttpError', message: 'down' })

    const { result } = renderHook(() => useQuerySearch({ mode: 'async', engine, search }))

    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(async () => {
      result.current.refresh()
    })
    expect(result.current.status).toBe('error')
    expect(result.current.results).toEqual([])
  })

  test('late answers from an aborted callback are ignored even if it disregards the signal', async () => {
    const first = deferredResults()
    const second = deferredResults()
    const search = (text: string) => (text === '' ? first.promise : second.promise)
    const { result } = renderHook(() => useQuerySearch({ mode: 'async', engine, search }))

    await act(async () => {
      result.current.apply('status:ready')
    })
    await act(async () => {
      second.resolve(records.slice(0, 1))
    })
    await act(async () => {
      first.resolve(records)
    })
    expect(result.current.applied).toBe('status:ready')
    expect(result.current.results).toEqual(records.slice(0, 1))
  })
})

function ConditionFixture({
  initial,
  facet,
}: {
  readonly initial: string
  readonly facet?: string
}) {
  const [value, setValue] = useState(initial)

  return (
    <Query.Root
      engine={engine}
      records={records}
      value={value}
      onValueChange={setValue}
      onSubmit={(next) => {
        setValue(next)

        return true
      }}
    >
      <Query.Chips />
      {facet ? <Query.Facets field={facet} /> : null}
      <output data-testid="query">{value}</output>
    </Query.Root>
  )
}

describe('field chip and facet values', () => {
  test.each([
    'carrier:"North Star"',
    'units:[100 TO 200]',
    'carrier:/North.*/',
    'carrier:Atlas~1',
    'status:r*',
    '-status:delivered',
  ])('the chip for %s is removable', (initial) => {
    render(<ConditionFixture initial={initial} />)
    const chip = screen.getByRole('button')

    expect(chip.hasAttribute('disabled')).toBe(false)
    fireEvent.click(chip)
    expect(screen.getByTestId('query').textContent).toBe('')
  })

  test('a quoted keyword facet is pressed and can be toggled off', () => {
    render(<ConditionFixture initial='carrier:"North Star"' facet="carrier" />)
    const facet = screen.getByRole('button', { name: 'North Star 2' })

    expect(facet.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(facet)
    expect(screen.getByTestId('query').textContent).toBe('')
  })

  test('free-text chips are still disabled', () => {
    render(<ConditionFixture initial="north" />)
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)
  })
})

function memoryStorage() {
  const data = new Map<string, string>()

  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
    removeItem: (key: string) => {
      data.delete(key)
    },
  }
}

describe('history namespaces', () => {
  test('switching keys loads the new entries and never carries old entries into a write', () => {
    const storage = memoryStorage()
    storage.setItem('a', JSON.stringify([{ text: 'status:ready', at: 1 }]))
    storage.setItem('b', JSON.stringify([{ text: 'status:delayed', at: 2 }]))

    const { result, rerender } = renderHook(
      ({ key }) => useQueryHistory({ engine, key, storage }),
      { initialProps: { key: 'a' } },
    )

    rerender({ key: 'b' })
    expect(result.current.entries.map((entry) => entry.text)).toEqual(['status:delayed'])
    act(() => result.current.push('status:delivered'))
    expect(JSON.parse(storage.getItem('b') ?? '[]')).toMatchObject([
      { text: 'status:delivered' },
      { text: 'status:delayed' },
    ])
    expect(JSON.parse(storage.getItem('a') ?? '[]')).toEqual([{ text: 'status:ready', at: 1 }])
  })

  test('switching storage reloads the same key and records the current applied value there', () => {
    const first = memoryStorage()
    const second = memoryStorage()
    second.setItem('h', JSON.stringify([{ text: 'status:delayed', at: 2 }]))

    const { result, rerender } = renderHook(
      ({ storage }) => useQueryHistory({ engine, key: 'h', storage, value: 'status:ready' }),
      { initialProps: { storage: first } },
    )

    rerender({ storage: second })
    expect(result.current.entries.map((entry) => entry.text)).toEqual([
      'status:ready',
      'status:delayed',
    ])
    act(() => result.current.clear())
    expect(JSON.parse(first.getItem('h') ?? '[]')).toMatchObject([{ text: 'status:ready' }])
    expect(second.getItem('h')).toBe('[]')
  })

  test('multiple pushes in one event retain every entry', () => {
    const storage = memoryStorage()
    const { result } = renderHook(() => useQueryHistory({ engine, storage }))

    act(() => {
      result.current.push('status:ready')
      result.current.push('status:delayed')
    })
    expect(result.current.entries.map((entry) => entry.text)).toEqual([
      'status:delayed',
      'status:ready',
    ])
  })
})

describe('query-only URL updates', () => {
  test.each([false, true])(
    'preserves the fragment and navigation metadata (replace=%s)',
    (replace) => {
      const state = { router: 'metadata', position: 4 }
      const writes: { state: typeof state; url: string }[] = []

      const history = {
        state,
        pushState: (data: typeof state, _unused: string, url: string) => {
          writes.push({ state: data, url })
        },
        replaceState: (data: typeof state, _unused: string, url: string) => {
          writes.push({ state: data, url })
        },
      }

      const target = { pathname: '/shipments', search: '?page=2&q=a', hash: '#details' }
      const { result } = renderHook(() => useQueryUrlState({ target, history, replace }))

      act(() => result.current[1]('status:ready'))
      act(() => result.current[1](''))
      expect(writes).toEqual([
        { state, url: '/shipments?page=2&q=status%3Aready#details' },
        { state, url: '/shipments?page=2#details' },
      ])
    },
  )
})
