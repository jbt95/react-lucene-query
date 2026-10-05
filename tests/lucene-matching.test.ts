import { describe, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'
import {
  hasErrors,
  tryCompileQuery,
  QueryEngine,
  type QueryField,
  type QueryValue,
} from '../src/core'
import { createQueryEngine } from '../src/engine-adapter'

interface Document {
  readonly id: number
  readonly text: string
  readonly code: string
}

const fields: readonly QueryField<Document>[] = [
  { key: 'text', label: 'Text', type: 'text', read: (record) => record.text, freeText: true },
  { key: 'code', label: 'Code', type: 'keyword', read: (record) => record.code },
]

const records: readonly Document[] = [
  { id: 1, text: 'North Star Logistics', code: 'SHP-1042' },
  { id: 2, text: 'arc delivery', code: 'SHP-1044' },
  { id: 3, text: 'atlas air freight', code: 'XYZ' },
]

const engine = createQueryEngine({ fields })

const ids = (text: string) => engine.filter(text, records).map((record) => record.id)

describe('phrase proximity', () => {
  test('proximity decides how far terms may move', () => {
    expect(ids('text:"north star"')).toEqual([1])
    expect(ids('text:"star north"~4')).toEqual([1])
    expect(ids('text:"star north"~1')).toEqual([])
    expect(ids('text:"north logistics"~1')).toEqual([1])
    expect(ids('text:"north logistics"~0')).toEqual([])
    expect(ids('text:""')).toEqual([])
  })
})

describe('fuzzy terms', () => {
  test('fuzzy distances count allowed edits', () => {
    expect(ids('north~')).toEqual([1])
    expect(ids('nort~')).toEqual([1])
    expect(ids('nort~0')).toEqual([])
    expect(ids('nortx~2')).toEqual([1])
    expect(ids('nortxyzw~2')).toEqual([])
    expect(ids('text:north~')).toEqual([1])
  })
})

describe('regular expressions', () => {
  test('patterns match complete analyzed tokens or complete keyword values', () => {
    expect(ids('text:/lo.*cs/')).toEqual([1])
    expect(ids('text:/LO.*CS/')).toEqual([])
    expect(ids('text:/arc|atlas/')).toEqual([2, 3])
    expect(ids('text:/nosuchtoken/')).toEqual([])
  })

  test('caret and dollar are literal characters, not anchors', () => {
    expect(ids('text:/arc/')).toEqual([2])
    expect(ids('text:/^arc$/')).toEqual([])
  })

  test('bounded repeats apply to the preceding element', () => {
    expect(ids('code:/SHP-[0-9]{4}/')).toEqual([1, 2])
    // A backslash escape is the literal next character, so this pattern needs four d's.
    expect(ids('code:/SHP-d{4}/')).toEqual([])
  })

  test.each(['text:/[/', 'text:/a{2,1}/'])('an invalid pattern reports %s', (text) => {
    expect(hasErrors(engine.parse(text))).toBe(true)
  })
})

describe('lexical ranges', () => {
  test('bounds and inclusivity select values', () => {
    expect(ids('code:[A TO M]')).toEqual([])
    expect(ids('code:[M TO Z]')).toEqual([1, 2, 3])
    expect(ids('code:{M TO Z}')).toEqual([1, 2, 3])
    expect(ids('code:[* TO SHP-1043]')).toEqual([1])
    expect(ids('code:[SHP-1042 TO *]')).toEqual([1, 2, 3])
    expect(ids('code:[XYZ TO XYZ]')).toEqual([3])
    expect(ids('code:{XYZ TO XYZ}')).toEqual([])
    expect(ids('code:[XYZ TO XZZ]')).toEqual([3])
  })

  test('a quoted star is a literal bound, not an open one', () => {
    // `*` sorts before every uppercase letter, so only SHP values fall inside.
    expect(ids('code:["*" TO "SHP-9999"]')).toEqual([1, 2])
    expect(ids('code:["*" TO "A"]')).toEqual([])
  })
})

describe('field types', () => {
  test('keyword fields match exactly and text fields are analyzed', () => {
    expect(ids('code:SHP-1042')).toEqual([1])
    expect(ids('code:shp-1042')).toEqual([])
    expect(ids('text:"SHP-1042"')).toEqual([])
    expect(ids('text:logistics')).toEqual([1])
    expect(ids('text:1042')).toEqual([])
    expect(ids('star')).toEqual([1])
    expect(ids('code:star')).toEqual([])
  })

  test('an analyzed term ORs its tokens instead of requiring their sequence', () => {
    expect(ids('text:north-logistics')).toEqual([1])
    expect(ids('text:"north-logistics"')).toEqual([])
  })
})

describe('occurrence semantics', () => {
  test('clause occurrence decides inclusion', () => {
    expect(ids('text:(arc OR atlas)')).toEqual([2, 3])
    expect(ids('text:arc AND code:SHP-1044')).toEqual([2])
    expect(ids('text:arc atlas')).toEqual([2, 3])
    expect(ids('text:arc OR code:XYZ')).toEqual([2, 3])
    expect(ids('*:* AND NOT text:arc')).toEqual([1, 3])
    expect(ids('text:arc AND NOT text:arc')).toEqual([])
    expect(ids('NOT text:arc')).toEqual([])
  })
})

describe('compiling a hand-built node', () => {
  const term = (value: QueryValue) => ({ type: 'term', field: 'code', value }) as const

  test('an ordinary node compiles to a predicate', () => {
    const compiled = tryCompileQuery(term({ kind: 'term', raw: 'SHP-1042' }), fields)

    expect(Result.isSuccess(compiled)).toBe(true)
    expect(Result.isSuccess(compiled) && compiled.success(records[0]!)).toBe(true)
  })

  test('a value outside the query language fails with a typed error, not a throw', () => {
    const rejected = [
      { kind: 'fuzzy', raw: 'ab', distance: 7 },
      { kind: 'wildcard', raw: 'a\\u12' },
      { kind: 'regex', raw: 'a{2,1}' },
    ] as const

    for (const value of rejected) {
      const compiled = tryCompileQuery(term(value), fields)

      expect(Result.isFailure(compiled)).toBe(true)
      expect(Result.isFailure(compiled) && compiled.failure._tag).toMatch(
        /QueryValueError|RegexSyntaxError/,
      )
    }
  })

  test('the engine turns a compile failure into a diagnostic instead of a defect', () => {
    const engine = Effect.runSync(QueryEngine.make({ fields }))

    for (const text of ['code:/a{2,1}/', 'code:[SHP TO', 'code:()', 'code:ready^0']) {
      const outcome = Effect.runSync(Effect.result(engine.compile(text)))

      expect(Result.isFailure(outcome)).toBe(true)
      expect(Result.isFailure(outcome) && outcome.failure.diagnostics.length).toBeGreaterThan(0)
    }
  })
})
