import { describe, expect, test } from 'bun:test'
import { createQueryEngine, facetCounts, type QueryField } from '../src'

interface Ticket {
  readonly team: string
  readonly tags: readonly string[]
  readonly priority: string
  readonly archived: boolean | null
}

const tickets: readonly Ticket[] = [
  { team: 'core', tags: ['parser', 'urgent'], priority: 'p1', archived: false },
  { team: 'core', tags: ['docs'], priority: 'p3', archived: false },
  { team: 'edge', tags: ['parser', 'urgent'], priority: 'p2', archived: null },
  { team: 'edge', tags: [], priority: 'p1', archived: true },
]

const fields: readonly QueryField<Ticket>[] = [
  { key: 'team', label: 'Team', type: 'keyword', read: (ticket) => ticket.team },
  { key: 'tags', label: 'Tags', type: 'keyword', read: (ticket) => ticket.tags },
  { key: 'priority', label: 'Priority', type: 'keyword', read: (ticket) => ticket.priority },
  { key: 'archived', label: 'Archived', type: 'keyword', read: (ticket) => ticket.archived },
]

const engine = createQueryEngine({ fields })

describe('facetCounts', () => {
  test('counts values among the records the query already selects', () => {
    const counts = engine.facets('tags:urgent', tickets)

    expect(counts.get('team')?.get('core')).toBe(1)
    expect(counts.get('team')?.get('edge')).toBe(1)
    expect(counts.get('priority')?.get('p1')).toBe(1)
    expect(counts.get('priority')?.get('p3')).toBeUndefined()
  })

  test('an unfiltered query counts every record', () => {
    expect(engine.facets('', tickets).get('priority')?.get('p1')).toBe(2)
  })

  test('a value no matching record holds is absent, not zero', () => {
    expect(engine.facets('team:core', tickets).get('priority')?.has('p2')).toBe(false)
  })

  test('restricted keys count only what was asked for', () => {
    const counts = engine.facets('', tickets, { keys: ['team'] })

    expect([...counts.keys()]).toEqual(['team'])
  })

  test('list values are counted once each', () => {
    expect(engine.facets('', tickets).get('tags')?.get('urgent')).toBe(2)
  })

  test('distinct counts a record once per value even when repeated', () => {
    const repeated: readonly Ticket[] = [
      { team: 'core', tags: ['a', 'a', 'b'], priority: 'p1', archived: false },
    ]

    expect(
      facetCounts(() => true, fields, repeated)
        .get('tags')
        ?.get('a'),
    ).toBe(2)
    expect(
      facetCounts(() => true, fields, repeated, { distinct: true })
        .get('tags')
        ?.get('a'),
    ).toBe(1)
  })

  test('blank and missing values are never counted', () => {
    const counts = engine.facets('', tickets).get('archived') ?? new Map()

    expect([...counts.keys()]).toEqual(['false', 'true'])
  })

  test('an invalid query fails instead of counting an arbitrary set', () => {
    expect(() => engine.facets('team:[a TO', tickets)).toThrow()
  })
})
