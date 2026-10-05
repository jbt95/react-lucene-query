import { describe, expect, test } from 'bun:test'
import { Option } from 'effect'
import { applySuggestion, getSuggestions, hasErrors, type QueryField } from '../src/core'
import { createQueryEngine } from '../src/engine-adapter'

const fields: readonly QueryField<{ readonly value: string; readonly active: boolean }>[] = [
  { key: 'value', label: 'Value', type: 'keyword', read: (record) => record.value },
  { key: 'active', label: 'Active', type: 'keyword', read: (record) => record.active },
]

const engine = createQueryEngine({ fields })

const records = [
  { value: 'alpha', active: true },
  { value: 'beta', active: false },
]

function complete(text: string, caret: number, id: string) {
  const list = engine.suggest(text, caret, records)

  if (!list) throw new Error('Expected suggestions')
  const item = list.items.find((candidate) => candidate.id === id)

  if (!item) throw new Error('Expected completion item')

  return applySuggestion(text, list, item)
}

describe('caret replacement boundaries', () => {
  test('field replacement consumes an existing colon but preserves its value', () => {
    const text = 'valxx:alpha AND active:true'
    const next = complete(text, 3, 'field:value')
    expect(next).toEqual({ value: 'value:alpha AND active:true', caret: 'value:'.length })
    expect(hasErrors(engine.parse(next.value))).toBe(false)
  })

  test('quoted value replacement removes the entire old token, not its suffix', () => {
    const text = 'value:"alzzz" OR value:beta'
    const next = complete(text, 'value:"al'.length, 'value:alpha')
    expect(next).toEqual({ value: 'value:alpha OR value:beta', caret: 'value:alpha'.length })
    expect(hasErrors(engine.parse(next.value))).toBe(false)
  })

  test.each([
    ['value:(alzzz OR beta)', 'value:(al', 'value:(alpha OR beta)', 'value:(alpha'],
    ['(value:alzzz)', '(value:al', '(value:alpha)', '(value:alpha'],
    ['value:(beta OR alzzz)', 'value:(beta OR al', 'value:(beta OR alpha)', 'value:(beta OR alpha'],
    [
      'value:((beta AND alzzz))',
      'value:((beta AND al',
      'value:((beta AND alpha))',
      'value:((beta AND alpha',
    ],
    [
      'value:(beta OR NOT (alzzz))',
      'value:(beta OR NOT (al',
      'value:(beta OR NOT (alpha))',
      'value:(beta OR NOT (alpha',
    ],
    [
      'value:(active:false OR (alzzz))',
      'value:(active:false OR (al',
      'value:(active:false OR (alpha))',
      'value:(active:false OR (alpha',
    ],
    ['value:(beta alzzz)', 'value:(beta al', 'value:(beta alpha)', 'value:(beta alpha'],
  ])(
    'scoped replacement keeps surrounding punctuation: %s',
    (text, prefix, expected, beforeCaret) => {
      const next = complete(text, prefix.length, 'value:alpha')
      expect(next).toEqual({ value: expected, caret: beforeCaret.length })
      expect(hasErrors(engine.parse(next.value))).toBe(false)
    },
  )

  test('explicit nested field scopes override inherited values', () => {
    const text = 'value:(alpha OR active:(false OR trzzz))'
    const next = complete(text, 'value:(alpha OR active:(false OR tr'.length, 'value:true')
    expect(next.value).toBe('value:(alpha OR active:(false OR true))')
    expect(hasErrors(engine.parse(next.value))).toBe(false)
    const list = engine.suggest(text, 'value:(alpha OR active:(false OR tr'.length, records)
    expect(list?.items.some((item) => item.id === 'value:alpha')).toBe(false)
  })

  test('explicit fields remain completable inside inherited groups', () => {
    const next = complete('value:(actxx:true OR beta)', 'value:(act'.length, 'field:active')
    expect(next.value).toBe('value:(active:true OR beta)')
    expect(hasErrors(engine.parse(next.value))).toBe(false)
  })

  test('value replacement preserves attached fuzzy and boost modifiers', () => {
    const text = 'value:alzzz~1^2 AND active:true'
    const next = complete(text, 'value:al'.length, 'value:alpha')
    expect(next).toEqual({ value: 'value:alpha~1^2 AND active:true', caret: 'value:alpha'.length })
    expect(hasErrors(engine.parse(next.value))).toBe(false)
  })

  test('escaped prefix completion preserves the suffix and caret', () => {
    const text = 'value:\\u0061lzzz OR active:true'
    const next = complete(text, 'value:\\u0061l'.length, 'value:alpha')
    expect(next).toEqual({ value: 'value:alpha OR active:true', caret: 'value:alpha'.length })
    expect(hasErrors(engine.parse(next.value))).toBe(false)
  })

  test('completing after negation preserves its excluded field operand', () => {
    const next = complete('-valxx:alpha', 4, 'field:value')
    expect(next).toEqual({ value: '-value:alpha', caret: '-value:'.length })
    expect(engine.filter(next.value, [{ value: 'alpha', active: true }])).toEqual([])
  })

  test('insertion at a token start does not join a new field to the existing token', () => {
    expect(engine.suggest('value:alpha', 0)).toBeUndefined()
    expect(engine.suggest('value:alpha', 'value:'.length)).toBeUndefined()
    expect(engine.suggest('value: alpha', 'value: '.length)).toBeUndefined()
  })
})

describe('completion values round-trip through execution', () => {
  test.each([
    '',
    '>edge',
    '<edge',
    'AND',
    'OR',
    'NOT',
    'TO',
    '-edge',
    '+edge',
    '!edge',
    'edge*',
    'edge?',
    'field:value',
    'a&&b',
    'a||b',
    '(group)',
    '[bound]',
    '{bound}',
    'fuzzy~2',
    'boost^2',
    '/regex/',
    'back\\slash',
    'quoted"value',
    'line\nbreak',
    'tab\tvalue',
  ])('completion preserves the keyword value %s', (value) => {
    const record = { value, active: true }
    const list = engine.suggest('value:', 'value:'.length, [record])

    // A blank value is never indexed, exactly like Lucene, so it is never offered either.
    if (value.trim() === '') {
      expect(list?.items.some((candidate) => candidate.id === `value:${value}`)).toBe(false)

      return
    }

    if (!list) throw new Error('Expected value suggestions')
    const item = list.items.find((candidate) => candidate.id === `value:${value}`)

    if (!item) throw new Error('Expected record value completion')
    const next = applySuggestion('value:', list, item)
    expect(next.caret).toBe(next.value.length)
    expect(hasErrors(engine.parse(next.value))).toBe(false)
    expect(engine.filter(next.value, [record, { value: 'different', active: false }])).toEqual([
      record,
    ])
  })

  test.each(['field name', 'a:b', '+-!(){}[]^"~*?\\/|&', 'AND', '日本 語'])(
    'field completion escapes the exact field name %s',
    (key) => {
      const unusualFields: readonly QueryField<string>[] = [
        { key, label: 'Special', type: 'keyword', read: (value) => value },
      ]

      const specialEngine = createQueryEngine({ fields: unusualFields })
      const list = specialEngine.suggest('', 0)
      const item = list?.items.find((candidate) => candidate.id === `field:${key}`)

      if (!list || !item) throw new Error('Expected field suggestion')
      const next = applySuggestion('', list, item)
      expect(next.caret).toBe(next.value.length)
      expect(hasErrors(specialEngine.parse(`${next.value}alpha`))).toBe(false)
      expect(specialEngine.filter(`${next.value}alpha`, ['alpha', 'beta'])).toEqual(['alpha'])
    },
  )

  test('counts exclude missing values and include duplicate record values', () => {
    const nullableFields: readonly QueryField<{ readonly value: string | null | undefined }>[] = [
      { key: 'value', label: 'Value', type: 'keyword', read: (record) => record.value },
    ]

    const list = Option.getOrThrow(
      getSuggestions('value:a', 'value:a'.length, nullableFields, [
        { value: 'alpha' },
        { value: 'alpha' },
        { value: 'alpine' },
        { value: null },
        { value: undefined },
      ]),
    )

    expect(list.items.map((item) => [item.label, item.count])).toEqual([
      ['alpha', 2],
      ['alpine', 1],
    ])
  })

  test('getValues supplies cached counts and limit only bounds record values', () => {
    let calls = 0

    const list = Option.getOrThrow(
      getSuggestions('value:a', 'value:a'.length, fields, [], {
        limit: 1,
        getValues: (field) => {
          calls += 1
          expect(field.key).toBe('value')

          return new Map([
            ['alpha', 4],
            ['alpine', 2],
          ])
        },
      }),
    )

    expect(calls).toBe(1)
    expect(list.items.map((item) => [item.id, item.count])).toEqual([['value:alpha', 4]])
  })

  test('options supply literal keyword values without inventing boolean values', () => {
    const configuredFields: readonly QueryField<string>[] = [
      {
        key: 'status',
        label: 'Status',
        type: 'keyword',
        options: ['open*', 'closed'],
        read: (value) => value,
      },
    ]

    const list = Option.getOrThrow(
      getSuggestions('status:op', 'status:op'.length, configuredFields),
    )

    const option = list.items.find((item) => item.id === 'value:open*')

    if (!option) throw new Error('Expected the configured option to be suggested')
    // The reserved wildcard character stays literal instead of becoming a pattern.
    expect(option.insert.trim()).toBe('"open*"')
    expect(hasErrors(engine.parse(`status:${option.insert.trim()}`))).toBe(false)
    // Values come from the data, so no boolean literal appears without matching records.
    expect(
      engine.suggest('active:tr', 'active:tr'.length)?.items.map((item) => item.id),
    ).not.toContain('value:true')
  })
})

describe('language completion patterns', () => {
  test.each(['[* TO *]', '{* TO *}', '*', '/.*/'])(
    'value template is valid Lucene: %s',
    (label) => {
      const next = complete('value:', 'value:'.length, `template:${label}`)
      expect(next.value).toBe(`value:${label}`)
      expect(hasErrors(engine.parse(next.value))).toBe(false)
    },
  )

  test.each([
    ['value:alpha', '~', 'value:alpha~'],
    ['value:alpha', '*', 'value:alpha*'],
    ['value:alpha', '?', 'value:alpha?'],
    ['value:alpha', '^2', 'value:alpha^2'],
    ['value:"alpha beta"', '~2', 'value:"alpha beta"~2'],
    ['value:(alpha OR beta)', '^2', 'value:(alpha OR beta)^2'],
    ['value:/alpha.*/', '^2', 'value:/alpha.*/^2'],
    ['value:[alpha TO beta]', '^2', 'value:[alpha TO beta]^2'],
  ])('modifier inserts after the operand without replacing it: %s %s', (text, label, expected) => {
    const next = complete(text, text.length, `template:${label}`)
    expect(next).toEqual({ value: expected, caret: expected.length })
    expect(hasErrors(engine.parse(next.value))).toBe(false)
  })

  test.each(['AND', 'OR', 'NOT'])(
    'operator replacement preserves the next condition: %s',
    (operator) => {
      const text = 'value:alpha  active:true'
      const next = complete(text, 'value:alpha '.length, `keyword:${operator}`)
      expect(next.value).toBe(`value:alpha ${operator}  active:true`)
      expect(hasErrors(engine.parse(next.value))).toBe(false)
    },
  )

  test.each([
    ['value:/alpha.*/', 'value:/al'],
    ['value:/unterminated', 'value:/unterminated'],
    ['value:"alpha beta"~12', 'value:"alpha beta"~1'],
    ['value:alpha~0.7', 'value:alpha~0.'],
    ['value:alpha^12', 'value:alpha^1'],
    ['value:alpha~', 'value:alpha~'],
    ['value:alpha^', 'value:alpha^'],
    ['value:[alpha TO beta]', 'value:[al'],
    ['value:AND al', 'value:AND al'],
    ['value:alpha AND OR al', 'value:alpha AND OR al'],
    ['value:alpha^^2 al', 'value:alpha^^2 al'],
    ['value:\\', 'value:\\'],
    ['value:\\u00', 'value:\\u00'],
    ['(value:alpha)) al', '(value:alpha)) al'],
  ])('does not complete regex, numeric modifiers, or malformed slots: %s', (text, prefix) => {
    expect(engine.suggest(text, prefix.length, records)).toBeUndefined()
  })

  test('unknown and differently cased fields do not receive invented values', () => {
    for (const text of ['unknown:a', 'unknown:(a', 'unknown:((a', 'VALUE:a']) {
      expect(engine.suggest(text, text.length, records)).toBeUndefined()
    }

    expect(hasErrors(engine.parse('unknown:alpha'))).toBe(false)
  })
})

describe('suggestion budgets', () => {
  test('text limits match parser code-unit limits', () => {
    const text = ' '.repeat(32765) + 'val'
    expect(engine.suggest(text, text.length)?.items.some((item) => item.id === 'field:value')).toBe(
      true,
    )
    expect(engine.suggest(' ' + text, text.length + 1)).toBeUndefined()
  })

  test('token limits accept the last permitted completion slot', () => {
    const text = Array.from({ length: 4095 }, () => 'x').join(' ') + ' val'
    expect(engine.suggest(text, text.length)?.items.some((item) => item.id === 'field:value')).toBe(
      true,
    )
    expect(engine.suggest('x ' + text, text.length + 2)).toBeUndefined()
  })

  test('invalid caret offsets never edit the source', () => {
    for (const caret of [-1, 100, 1.5, Number.NaN]) {
      expect(engine.suggest('value:', caret, records)).toBeUndefined()
    }
  })
})
