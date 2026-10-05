import { describe, expect, test } from 'bun:test'
import { compileRegex, RegexSyntaxError, validateRegex } from '../src/core/regexp'

const cases: readonly {
  pattern: string
  accepts: readonly string[]
  rejects: readonly string[]
}[] = [
  { pattern: '', accepts: [''], rejects: ['a'] },
  { pattern: '()', accepts: [''], rejects: ['a'] },
  { pattern: 'ab|cd', accepts: ['ab', 'cd'], rejects: ['', 'abcd', 'a', 'xab', 'cdx'] },
  { pattern: 'a(b|c)d', accepts: ['abd', 'acd'], rejects: ['ad', 'abcd', 'bad'] },
  { pattern: '[a-cx-z]+', accepts: ['abcxyz', 'za'], rejects: ['', 'd', 'Ax'] },
  { pattern: '[^a-c]', accepts: ['d', 'é', '😀', '\n'], rejects: ['', 'a', 'b', 'cc', '😀d'] },
  { pattern: '.', accepts: ['a', '😀', '\n', '\u0000'], rejects: ['', 'ab', '😀a'] },
  { pattern: 'colou?r', accepts: ['color', 'colour'], rejects: ['colouur', 'colr'] },
  { pattern: 'ab*', accepts: ['a', 'ab', 'abbb'], rejects: ['', 'b', 'aba'] },
  { pattern: 'ab+', accepts: ['ab', 'abbb'], rejects: ['', 'a', 'aba'] },
  { pattern: '(ab){2}', accepts: ['abab'], rejects: ['', 'ab', 'ababab'] },
  { pattern: '(ab){1,3}', accepts: ['ab', 'abab', 'ababab'], rejects: ['', 'abababab'] },
  { pattern: 'a{2,}', accepts: ['aa', 'aaa', 'a'.repeat(300)], rejects: ['', 'a', 'aab'] },
  { pattern: 'a{0}', accepts: [''], rejects: ['a'] },
  { pattern: 'a{0,2}', accepts: ['', 'a', 'aa'], rejects: ['aaa'] },
  { pattern: '(a?)*', accepts: ['', 'a', 'aaaa'], rejects: ['b', 'ab'] },
  { pattern: 'a**', accepts: ['', 'a', 'aaa'], rejects: ['b'] },
  { pattern: '#', accepts: [], rejects: ['', 'a', '😀'] },
  { pattern: '#*', accepts: [''], rejects: ['a'] },
  { pattern: '@', accepts: ['', 'a', '😀\nabc'], rejects: [] },
  { pattern: 'a#b', accepts: [], rejects: ['', 'ab', 'a#b'] },
  { pattern: '#|ab', accepts: ['ab'], rejects: ['', 'a', '#'] },
  { pattern: '@&a+', accepts: ['a', 'aaa'], rejects: ['', 'b', 'ab'] },
  { pattern: '[a-c]+&[b-d]+', accepts: ['b', 'cb', 'bcbb'], rejects: ['', 'a', 'd', 'abc'] },
  { pattern: '~(ab)', accepts: ['', 'a', 'abc', 'b', '😀'], rejects: ['ab'] },
  { pattern: '~~(ab)', accepts: ['ab'], rejects: ['', 'a', 'abc'] },
  { pattern: '~#', accepts: ['', 'anything', '😀'], rejects: [] },
  { pattern: '~@', accepts: [], rejects: ['', 'a', '😀'] },
  { pattern: 'a|b&b', accepts: ['a', 'b'], rejects: ['', 'ab'] },
  { pattern: 'ab&ab|c', accepts: ['ab', 'c'], rejects: ['', 'a', 'abc'] },
  { pattern: '~a*', accepts: ['', 'b', 'bb', 'aaa'], rejects: ['a'] },
  { pattern: '~(a*)', accepts: ['b', 'ab', 'ba'], rejects: ['', 'a', 'aaa'] },
  { pattern: '"a|b.*"', accepts: ['a|b.*'], rejects: ['a', 'b', 'ab'] },
  { pattern: '""', accepts: [''], rejects: ['a'] },
  { pattern: '"\\d"', accepts: ['\\d'], rejects: ['d', '5'] },
  { pattern: '\\d', accepts: ['d'], rejects: ['5', '\\d'] },
  { pattern: '\\u0041', accepts: ['u0041'], rejects: ['A'] },
  {
    pattern: '\\*\\?\\|\\&\\~\\#\\@\\<\\>\\.\\[\\]\\{\\}\\(\\)\\"\\\\',
    accepts: ['*?|&~#@<>.[]{}()"\\'],
    rejects: ['', 'a'],
  },
  { pattern: '[\\]\\[\\-\\.\\*]', accepts: [']', '[', '-', '.', '*'], rejects: ['a', '', '**'] },
  { pattern: 'é😀{2}', accepts: ['é😀😀'], rejects: ['e😀😀', 'é😀', 'é😀😀😀'] },
  { pattern: '[😀-🙏]', accepts: ['😀', '😃', '🙏'], rejects: ['🦄', 'a', '😀😀'] },
  { pattern: '[^😀-🙏]+', accepts: ['🦄é', 'ab'], rejects: ['', '😀', 'é😃'] },
  { pattern: 'é', accepts: ['é'], rejects: ['É', 'e\u0301'] },
  { pattern: '<01-12>', accepts: ['01', '09', '12'], rejects: ['1', '001', '00', '13', 'a01'] },
  {
    pattern: '<1-12>',
    accepts: ['1', '9', '12', '01', '00012'],
    rejects: ['', '0', '13', '1.0', '-1'],
  },
  { pattern: '<12-01>', accepts: ['01', '12'], rejects: ['1', '00', '13'] },
  { pattern: '<12-1>', accepts: ['1', '12', '0009'], rejects: ['0', '13'] },
  { pattern: '<0-10>', accepts: ['0', '00', '000', '1', '09', '10'], rejects: ['', '11', '-0'] },
  {
    pattern: '<000-010>',
    accepts: ['000', '001', '010'],
    rejects: ['0', '00', '01', '011', '0000'],
  },
  { pattern: 'x<8-11>y', accepts: ['x8y', 'x09y', 'x11y'], rejects: ['x7y', 'x12y', '8', 'x8'] },
  {
    pattern: '<10000000000000000000-10000000000000000002>',
    accepts: ['10000000000000000000', '10000000000000000001', '10000000000000000002'],
    rejects: ['10000000000000000003', '9999999999999999999'],
  },
]

describe('classic Lucene regexp language', () => {
  for (const { pattern, accepts, rejects } of cases) {
    test(`whole-token language: ${JSON.stringify(pattern)}`, () => {
      expect(validateRegex(pattern)).toBeUndefined()
      const match = compileRegex(pattern)

      for (const term of accepts) expect(match(term)).toBe(true)

      for (const term of rejects) expect(match(term)).toBe(false)
    })
  }

  test('a matcher keeps independent state between calls', () => {
    const match = compileRegex('(ab|😀)+')

    for (let index = 0; index < 20; index++) {
      expect(match('ab😀ab')).toBe(true)
      expect(match('ab😀a')).toBe(false)
      expect(match('😀')).toBe(true)
      expect(match('')).toBe(false)
    }
  })

  test('intersection and complement obey language algebra', () => {
    const words = ['']
    let frontier = ['']

    for (let length = 0; length < 6; length++) {
      const next: string[] = []

      for (const prefix of frontier) {
        next.push(`${prefix}a`, `${prefix}b`)
      }

      words.push(...next)
      frontier = next
    }

    const a = compileRegex('(ab|b)*')
    const b = compileRegex('a*b*')
    const union = compileRegex('(ab|b)*|a*b*')
    const intersection = compileRegex('(ab|b)*&a*b*')
    const difference = compileRegex('(ab|b)*&~(a*b*)')
    const deMorgan = compileRegex('~(~((ab|b)*)&~(a*b*))')
    const impossible = compileRegex('(ab|b)*&~((ab|b)*)')
    const universal = compileRegex('(ab|b)*|~((ab|b)*)')

    for (const word of words) {
      expect(union(word)).toBe(a(word) || b(word))
      expect(intersection(word)).toBe(a(word) && b(word))
      expect(difference(word)).toBe(a(word) && !b(word))
      expect(deMorgan(word)).toBe(union(word))
      expect(impossible(word)).toBe(false)
      expect(universal(word)).toBe(true)
    }
  })

  test('numeric intervals agree with decimal membership across boundaries', () => {
    for (const [lower, upper] of [
      [0, 12],
      [8, 105],
      [98, 102],
      [21, 3],
    ] as const) {
      const match = compileRegex(`<${lower}-${upper}>`)

      for (let value = 0; value < 120; value++) {
        const expected = value >= Math.min(lower, upper) && value <= Math.max(lower, upper)

        for (const prefix of ['', '0', '000']) expect(match(`${prefix}${value}`)).toBe(expected)
      }
    }

    const fixed = compileRegex('<008-105>')

    for (let value = 0; value < 120; value++) {
      expect(fixed(String(value).padStart(3, '0'))).toBe(value >= 8 && value <= 105)
    }
  })

  test('long adversarial terms cannot cause backtracking or a matching budget failure', () => {
    const match = compileRegex('(a|aa)*b')
    const term = 'a'.repeat(100000)
    expect(match(term)).toBe(false)
    expect(match(`${term}b`)).toBe(true)
    const complement = compileRegex('~((a|aa)*b)')
    expect(complement(term)).toBe(true)
    expect(complement(`${term}b`)).toBe(false)
  })
})

describe('regexp diagnostics and deterministic limits', () => {
  for (const pattern of [
    '\\',
    '(',
    ')',
    'a)',
    'a|',
    '|a',
    'a||b',
    'a&',
    '&a',
    '~',
    '*a',
    '?a',
    '+a',
    '[',
    '[]',
    '[^]',
    '[a',
    '[z-a]',
    '[a-]',
    '"unterminated',
    'a{',
    'a{}',
    'a{,2}',
    'a{2,1}',
    'a{1,2',
    'a{1,,2}',
    '<>',
    '<1>',
    '<name>',
    '<-1-3>',
    '<1->',
    '<1-2',
    '<1-2-3>',
    '<1.0-2>',
    '>',
    '{',
    ']',
  ]) {
    test(`invalid syntax: ${JSON.stringify(pattern)}`, () => {
      expect(validateRegex(pattern)).toBeString()
      expect(() => compileRegex(pattern)).toThrow(RegexSyntaxError)
    })
  }

  for (const [resource, pattern] of [
    ['pattern length', 'a'.repeat(8193)],
    ['nesting', `${'('.repeat(65)}a${')'.repeat(65)}`],
    ['complement nesting', `${'~'.repeat(65)}a`],
    ['repetition', 'a{257}'],
    ['large repetition', 'a{9999999999999999999999999999}'],
    ['nested repetition expansion', '(a{256}){256}'],
    ['interval digit count', `<${'1'.repeat(65)}-${'2'.repeat(65)}>`],
    ['determinization', '(a|b)*a(a|b){12}'],
    [
      'character partitions',
      Array.from({ length: 1025 }, (_, index) => String.fromCodePoint(0x1000 + index * 2)).join(
        '|',
      ),
    ],
  ] as const) {
    test(`compilation rejects ${resource} before matching`, () => {
      const first = validateRegex(pattern)
      expect(first).toBeString()
      expect(first).toContain('limit exceeded')
      expect(validateRegex(pattern)).toBe(first)
      expect(() => compileRegex(pattern)).toThrow(RegexSyntaxError)
    })
  }
})

describe('compiled automaton reuse', () => {
  test('results stay correct once the bounded cache evicts and clears', () => {
    // Many distinct patterns overrun the cache, so correctness cannot depend on a retained entry.
    const patterns = Array.from(
      { length: 200 },
      (_, index) => `a{1,${(index % 5) + 1}}b${index % 7}c`,
    )

    for (const pattern of patterns) {
      const matcher = compileRegex(pattern)
      const equivalent = new RegExp(`^${pattern}$`)

      for (const term of ['a1b0c', 'a12b3c', 'zzz', '', 'ab', 'a12345b0c']) {
        expect(matcher(term)).toBe(equivalent.test(term))
      }
    }
  })

  test('a rejected pattern keeps failing after valid patterns are compiled', () => {
    const invalid = 'a{3,1}'

    for (let index = 0; index < 100; index += 1) {
      expect(validateRegex(`x{1,${(index % 4) + 1}}y`)).toBeUndefined()
      expect(validateRegex(invalid)).toBeString()
      expect(() => compileRegex(invalid)).toThrow(RegexSyntaxError)
    }
  })
})
