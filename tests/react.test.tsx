import { afterEach, describe, expect, test } from 'bun:test'
import { StrictMode, useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { createQueryEngine, Query, useQueryContext, useQuerySearch } from '../src'
import { QuerySearchField } from '../src/styled'
import { fields, records } from './fixtures'

afterEach(cleanup)

const engine = createQueryEngine({ fields, today: '2026-10-24' })

function Fixture({ defaultValue = '' }: { readonly defaultValue?: string }) {
  const search = useQuerySearch({ engine, records, defaultValue })

  return (
    <>
      <QuerySearchField
        engine={engine}
        records={records}
        label="Search shipments"
        value={search.draft}
        parsed={search.parsedDraft}
        onValueChange={search.setDraft}
        onSubmit={search.submit}
      />
      <output data-testid="applied">{search.applied}</output>
      <output data-testid="count">{search.matches.length}</output>
    </>
  )
}

describe('search state', () => {
  test('draft/applied separation and invalid-submit preservation', () => {
    const { result } = renderHook(() => useQuerySearch({ engine, records }))
    act(() => result.current.setDraft('status:ready'))
    expect(result.current.matches.length).toBe(4)
    expect(result.current.isPending).toBe(true)
    act(() => {
      expect(result.current.submit()).toBe(true)
    })
    expect(result.current.matches.length).toBe(2)
    act(() => {
      expect(result.current.apply('units:invalid')).toBe(false)
    })
    expect(result.current.applied).toBe('status:ready')
    expect(result.current.matches.length).toBe(2)
    act(() => {
      result.current.clear()
    })
    expect(result.current.matches.length).toBe(4)
    expect(result.current.draft).toBe('')
  })

  test('controlled values remain owned by the consumer; callback sees parsed AST', () => {
    const values: string[] = []
    const applied: string[] = []

    const { result, rerender } = renderHook(
      ({ value, appliedValue }) =>
        useQuerySearch({
          engine,
          records,
          value,
          appliedValue,
          onValueChange: (next) => {
            values.push(next)
          },
          onApply: (next, parsed) => {
            applied.push(next)
            expect(parsed.text).toBe(next)
          },
        }),
      { initialProps: { value: '', appliedValue: '' } },
    )

    act(() => result.current.setDraft('status:ready'))
    expect(values).toEqual(['status:ready'])
    expect(result.current.draft).toBe('')
    rerender({ value: 'status:ready', appliedValue: '' })
    act(() => {
      result.current.submit()
    })
    expect(applied).toEqual(['status:ready'])
    expect(result.current.applied).toBe('')
    rerender({ value: 'status:ready', appliedValue: 'status:ready' })
    expect(result.current.matches.length).toBe(2)
  })

  test('backend-only state works without records', () => {
    const { result } = renderHook(() => useQuerySearch({ engine }))
    act(() => {
      expect(result.current.apply('status:ready')).toBe(true)
    })
    expect(result.current.applied).toBe('status:ready')
    expect(result.current.matches).toEqual([])
  })
})

describe('composable editor', () => {
  test('Tab completes a field; Escape dismisses; Ctrl+Space reopens', () => {
    render(
      <StrictMode>
        <Fixture defaultValue="car" />
      </StrictMode>,
    )
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    expect(screen.getByRole('listbox')).toBeDefined()
    expect(input.getAttribute('aria-activedescendant')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(screen.getByRole('combobox').getAttribute('aria-expanded')).toBe('true')

    if (!(input instanceof HTMLTextAreaElement)) throw new Error('Expected a textarea')
    expect(input.value).toBe('carrier:')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.getAttribute('aria-expanded')).toBe('false')
    fireEvent.keyDown(input, { key: ' ', ctrlKey: true })
    expect(input.getAttribute('aria-expanded')).toBe('true')
  })

  test('arrow navigation and mouse selection preserve input focus', () => {
    render(<Fixture />)
    const input = screen.getByRole('combobox')
    act(() => {
      input.focus()
    })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const active = input.getAttribute('aria-activedescendant')
    expect(active).toBeTruthy()
    const option = screen.getAllByRole('option')[1]

    if (!option) throw new Error('Expected an option')
    fireEvent.mouseDown(option)
    expect(document.activeElement).toBe(input)
  })

  test('Enter applies a complete query instead of inserting an operator', () => {
    render(<Fixture defaultValue="status:ready" />)
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByTestId('applied').textContent).toBe('status:ready')
    expect(screen.getByTestId('count').textContent).toBe('2')
  })

  test('invalid submission is announced and leaves the applied query unchanged', () => {
    render(<Fixture />)
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'units:bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByTestId('applied').textContent).toBe('')
    expect(screen.getByTestId('count').textContent).toBe('4')
    expect(
      document.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toContain('number')
  })

  test('clear applies the empty query and restores all records', () => {
    render(<Fixture defaultValue="status:ready" />)
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.getByTestId('count').textContent).toBe('4')
    expect(screen.getByTestId('applied').textContent).toBe('')
  })

  test('IME Enter does not submit', () => {
    render(<Fixture defaultValue="active:true" />)
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', isComposing: true })
    expect(screen.getByTestId('applied').textContent).toBe('')
  })

  test('input consumer can prevent internal keyboard behavior and obtain a ref', () => {
    function Custom() {
      const [value, setValue] = useState('car')
      const ref = useRef<HTMLTextAreaElement>(null)

      return (
        <Query.Root engine={engine} value={value} onValueChange={setValue} onSubmit={() => true}>
          <Query.Input
            aria-label="Custom query"
            ref={ref}
            onKeyDown={(event) => {
              event.preventDefault()
            }}
          />
          <Query.Diagnostics />
          <button type="button" onClick={() => ref.current?.focus()}>
            Focus
          </button>
        </Query.Root>
      )
    }

    render(<Custom />)
    const input = screen.getByRole('combobox')
    fireEvent.click(screen.getByRole('button', { name: 'Focus' }))
    expect(document.activeElement).toBe(input)
    fireEvent.keyDown(input, { key: 'Tab' })

    if (!(input instanceof HTMLTextAreaElement)) throw new Error('Expected a textarea')
    expect(input.value).toBe('car')
  })

  test('primitives fail clearly outside their root', () => {
    expect(() => renderHook(() => useQueryContext())).toThrow(
      'Query primitives must be rendered inside Query.Root',
    )
  })
})
