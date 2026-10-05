import { describe, expect, test } from 'bun:test'
import { createQueryEngine, readPath, toggleClause, type QueryField } from '../src'

interface Article {
  readonly title: string
  readonly tags: readonly string[]
  readonly units: number
  readonly due: string
  readonly note?: string | null
}

const articles: readonly [Article, Article, Article] = [
  {
    title: 'Café Run',
    tags: ['design', 'urgent'],
    units: 1200,
    due: '2026-10-24',
    note: 'needs 1,000 review',
  },
  { title: 'Budget', tags: ['finance'], units: 35, due: '2026-10-25', note: null },
  { title: 'Roadmap', tags: ['design', 'finance'], units: 450, due: '2024-02-29', note: undefined },
]

// Named fixtures keep `noUncheckedIndexedAccess` out of every expectation below.
const [cafeRun, budget, roadmap] = articles

const fields: readonly QueryField<Article>[] = [
  { key: 'title', label: 'Title', type: 'text', read: (article) => article.title, freeText: true },
  { key: 'tags', label: 'Tags', type: 'keyword', read: (article) => article.tags },
  { key: 'units', label: 'Units', type: 'number', read: (article) => article.units },
  { key: 'due', label: 'Due', type: 'date', read: (article) => article.due },
  { key: 'note', label: 'Note', type: 'text', read: (article) => article.note },
]

const engine = createQueryEngine({ fields })

/** Hands the engine configuration it must reject, which the public types would otherwise forbid. */
function rejected(...candidates: readonly unknown[]) {
  // SAFETY: these cases exist precisely to reach the engine's own configuration guard.
  return { fields: candidates } as never
}

describe('multi-valued fields', () => {
  test('any value of a list field matches its own term', () => {
    expect(engine.filter('tags:finance', articles)).toEqual([budget, roadmap])
    expect(engine.filter('tags:design AND tags:urgent', articles)).toEqual([cafeRun])
  })

  test('a list field never matches a joined representation', () => {
    expect(engine.filter('tags:"design,urgent"', articles)).toEqual([])
  })

  test('blank entries stay unindexed, exactly like a missing value', () => {
    const blankFields: readonly QueryField<Article>[] = [
      { key: 'tags', label: 'Tags', type: 'keyword', read: (article) => [...article.tags, '  '] },
    ]

    const blank = createQueryEngine({ fields: blankFields })

    expect(blank.filter('tags:""', articles)).toEqual([])
    expect(blank.filter('tags:design', articles)).toEqual([cafeRun, roadmap])
  })

  test('suggestions count every value of a list field', () => {
    const list = engine.suggest('tags:', 'tags:'.length, articles)
    const labels = list?.items.map((item) => item.label) ?? []

    expect(labels).toContain('design')
    expect(labels).toContain('finance')
  })

  test('facets count list values without double counting one record', () => {
    const counts = engine.facets('', articles).get('tags')

    expect(counts?.get('design')).toBe(2)
    expect(counts?.get('finance')).toBe(2)
    expect(counts?.get('urgent')).toBe(1)
  })
})

describe('path fields', () => {
  const nested = { meta: { owner: { name: 'Ada' } }, tags: ['a', 'b'] }

  test('reads dotted and indexed property paths', () => {
    expect(readPath(nested, 'tags.0')).toBe('a')
    expect(readPath(nested, 'tags.1')).toBe('b')
    expect(readPath(nested, 'meta.owner.name')).toBe('Ada')
    expect(readPath(nested, 'meta.missing.name')).toBeUndefined()
    expect(readPath(undefined, 'meta.owner.name')).toBeUndefined()
  })

  test('never walks into the prototype chain', () => {
    expect(readPath(nested, '__proto__.polluted')).toBeUndefined()
    expect(readPath(nested, 'constructor.name')).toBeUndefined()
    expect(readPath(nested, 'meta.constructor.name')).toBeUndefined()
  })

  test('searches records the same way a read accessor would', () => {
    const pathFields: readonly QueryField<typeof nested>[] = [
      { key: 'owner', label: 'Owner', type: 'keyword', path: 'meta.owner.name' },
      { key: 'tags', label: 'Tags', type: 'keyword', path: 'tags' },
    ]

    const byPath = createQueryEngine({ fields: pathFields })

    expect(byPath.filter('owner:Ada', [nested])).toEqual([nested])
    expect(byPath.filter('tags:b', [nested])).toEqual([nested])
  })

  test('a field needs exactly one accessor', () => {
    expect(() =>
      createQueryEngine(rejected([{ key: 'title', label: 'Title', type: 'text' }])),
    ).toThrow()

    expect(() =>
      createQueryEngine(
        rejected([
          {
            key: 'title',
            label: 'Title',
            type: 'text',
            path: 'title',
            read: (article: Article) => article.title,
          },
        ]),
      ),
    ).toThrow()
  })
})

describe('per-field analysis', () => {
  const folded: readonly QueryField<Article>[] = [
    {
      key: 'title',
      label: 'Title',
      type: 'text',
      freeText: true,
      read: (article) => article.title,
      // Folding diacritics is exactly what a consumer cannot express with configuration alone.
      analyze: (value) =>
        value
          .normalize('NFD')
          .replaceAll(/\p{Diacritic}/gu, '')
          .toLowerCase()
          .match(/[\p{L}\p{N}]+/gu) ?? [],
    },
  ]

  test('the field analyzer replaces the default tokenizer on both sides', () => {
    const foldedEngine = createQueryEngine({ fields: folded })

    expect(foldedEngine.filter('cafe', articles)).toEqual([cafeRun])
    expect(foldedEngine.filter('Café', articles)).toEqual([cafeRun])
  })

  test('the default analyzer is unchanged for fields without one', () => {
    expect(engine.filter('café', articles)).toEqual([cafeRun])
  })

  test('a unit-normalizing analyzer makes stored and written values agree', () => {
    const numeric: readonly QueryField<Article>[] = [
      {
        key: 'note',
        label: 'Note',
        type: 'text',
        freeText: true,
        read: (article) => article.note,
        analyze: (value) => value.replaceAll(',', '').toLowerCase().split(/\s+/u),
      },
    ]

    const numericEngine = createQueryEngine({ fields: numeric })

    // The analyzer normalizes stored values and written terms alike, so both spellings agree.
    expect(numericEngine.filter('1000', articles)).toEqual([cafeRun])
    expect(numericEngine.filter('1,000', articles)).toEqual([cafeRun])
    expect(numericEngine.filter('review', articles)).toEqual([cafeRun])
  })
})

describe('number fields', () => {
  test('compares numerically rather than lexically', () => {
    expect(engine.filter('units:[1000 TO 2000]', articles)).toEqual([cafeRun])
    expect(engine.filter('units:[35 TO 35]', articles)).toEqual([budget])
  })

  test('an exact term compares as a number', () => {
    expect(engine.filter('units:450', articles)).toEqual([roadmap])
  })

  test('a formatted or unparseable term matches nothing', () => {
    expect(engine.filter('units:1,200', articles)).toEqual([])
    expect(engine.filter('units:many', articles)).toEqual([])
  })

  test('an unsatisfiable bound rejects the clause instead of ignoring it', () => {
    expect(engine.filter('units:[many TO 2000]', articles)).toEqual([])
  })

  test('exclusive bounds exclude the endpoints', () => {
    expect(engine.filter('units:[35 TO 450]', articles)).toEqual([budget, roadmap])
    expect(engine.filter('units:{35 TO 450}', articles)).toEqual([])
    expect(engine.filter('units:{34 TO 451}', articles)).toEqual([budget, roadmap])
  })

  test('a wildcard over a number is not a digit wildcard', () => {
    expect(engine.filter('units:1*', articles)).toEqual([])
  })
})

describe('date fields', () => {
  test('a partially written date covers its whole window', () => {
    expect(engine.filter('due:2026-10', articles)).toEqual([cafeRun, budget])
    expect(engine.filter('due:2026', articles)).toEqual([cafeRun, budget])
    expect(engine.filter('due:2026-10-24', articles)).toEqual([cafeRun])
  })

  test('ranges compare instants, with inclusive bounds covering the whole window', () => {
    expect(engine.filter('due:[2026-10-01 TO 2026-10-24]', articles)).toEqual([cafeRun])
    // An exclusive bound drops the entire window it names, so both October days fall outside it.
    expect(engine.filter('due:{2026-10-01 TO 2026-10-24}', articles)).toEqual([])
  })

  test('open bounds are supported in both directions', () => {
    expect(engine.filter('due:[2026-10 TO *]', articles)).toEqual([cafeRun, budget])
    expect(engine.filter('due:[* TO 2024-03-01]', articles)).toEqual([roadmap])
  })

  test('a calendar form wins over epoch milliseconds', () => {
    expect(engine.filter('due:1970', articles)).toEqual([])
  })

  test('epoch milliseconds still match when no calendar form is possible', () => {
    const epochFields: readonly QueryField<{ at: number }>[] = [
      { key: 'at', label: 'At', type: 'date', read: (record) => record.at },
    ]

    const epoch = createQueryEngine({ fields: epochFields })

    expect(epoch.filter('at:[1000 TO 2000]', [{ at: 1500 }])).toEqual([{ at: 1500 }])
  })

  test('an impossible or unparseable date matches nothing', () => {
    expect(engine.filter('due:2026-02-30', articles)).toEqual([])
    expect(engine.filter('due:tuesday', articles)).toEqual([])
  })

  test('a leap day is a real date and an impossible one is not', () => {
    expect(engine.filter('due:2024-02-29', articles)).toEqual([roadmap])
    expect(engine.filter('due:2024-02-30', articles)).toEqual([])
  })
})

describe('unknown fields', () => {
  test('a mistyped field suggests the nearest configured key without failing the query', () => {
    const parsed = engine.parse('unites:[100 TO 200]')

    expect(parsed.node).toBeDefined()
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "No field named 'unites' in this schema. Did you mean 'units'?",
    ])
    expect(parsed.diagnostics[0]?.severity).toBe('warning')
  })

  test('a warning is not an error, so the query still compiles', () => {
    expect(engine.filter('unites:[100 TO 200]', articles)).toEqual([])
  })

  test('strict mode rejects the query instead', () => {
    const strict = createQueryEngine({ fields, unknownFields: 'error' })

    expect(strict.parse('unites:[100 TO 200]').diagnostics[0]?.severity).toBe('error')
  })

  test('ignoring unknown fields stays silent, and `*:*` is always known', () => {
    const quiet = createQueryEngine({ fields, unknownFields: 'ignore' })

    expect(quiet.parse('unites:[100 TO 200]').diagnostics).toEqual([])
    expect(quiet.parse('*:*').diagnostics).toEqual([])
  })

  test('an unrelated typo gets no invented suggestion', () => {
    const parsed = engine.parse('zzzzzz:ready')

    expect(parsed.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "No field named 'zzzzzz' in this schema.",
    ])
  })
})

describe('toggleClause over multi-valued and typed fields', () => {
  test('adds a condition to an empty query, then removes it', () => {
    const added = toggleClause('', { field: 'tags', value: 'design' })

    expect(added).toBe('tags:design')
    expect(engine.filter(added, articles)).toEqual([cafeRun, roadmap])
    // Removing restores the original meaning, which is the property that matters: the canonical
    // text re-quotes and re-prefixes the tree without changing what the query selects.
    expect(
      engine.filter(toggleClause(added, { field: 'tags', value: 'design' }), articles),
    ).toEqual(engine.filter('', articles))
  })

  test('narrowing an existing query survives the canonical rewrite', () => {
    const narrowed = toggleClause('units:[1000 TO 2000]', { field: 'tags', value: 'finance' })

    expect(engine.filter(narrowed, articles)).toEqual([])
    expect(
      engine.filter(toggleClause(narrowed, { field: 'tags', value: 'finance' }), articles),
    ).toEqual([cafeRun])
  })

  test('an unparseable query is never rewritten', () => {
    expect(toggleClause('units:[1000 TO', { field: 'tags', value: 'design' })).toBe(
      'units:[1000 TO',
    )
  })
})
