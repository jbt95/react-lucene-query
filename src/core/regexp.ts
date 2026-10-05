// Classic Lucene RegExp grammar, without named automata or Java regexp escapes.
// Compile every transition before matching. Input cannot add states or consume a work budget.
import { RegexSyntaxError } from './errors'

export { RegexSyntaxError }

const MAX_CODE_POINT = 0x10ffff

const LIMITS = {
  pattern: 8192,
  nesting: 64,
  depth: 128,
  sequence: 8192,
  repeat: 256,
  intervalDigits: 64,
  nodes: 20000,
  states: 2048,
  alphabet: 1024,
  transitions: 200000,
  work: 1000000,
} as const

type Range = readonly [number, number]

type Kind =
  | 'empty'
  | 'epsilon'
  | 'any'
  | 'chars'
  | 'union'
  | 'intersection'
  | 'concat'
  | 'not'
  | 'star'

interface Expression {
  readonly id: number
  readonly kind: Kind
  readonly children: readonly Expression[]
  readonly ranges: readonly Range[]
  readonly nullable: boolean
  readonly depth: number
}

function exceeded(resource: string, limit: number): never {
  throw new RegexSyntaxError({
    message: `Regex ${resource} limit exceeded (${limit}); simplify the pattern.`,
  })
}

function normalizeRanges(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const merged: Range[] = []

  for (const range of sorted) {
    const previous = merged[merged.length - 1]

    if (previous && range[0] <= previous[1] + 1) {
      merged[merged.length - 1] = [previous[0], Math.max(previous[1], range[1])]
    } else merged.push(range)
  }

  return merged
}

function invertRanges(ranges: readonly Range[]): Range[] {
  const inverted: Range[] = []
  let start = 0

  for (const [lower, upper] of ranges) {
    if (start < lower) inverted.push([start, lower - 1])
    start = upper + 1
  }

  if (start <= MAX_CODE_POINT) inverted.push([start, MAX_CODE_POINT])

  return inverted
}

class Expressions {
  private readonly interned = new Map<string, Expression>()
  private readonly derivatives = new Map<string, Expression>()
  private work = 0
  readonly boundaries = new Set([0, MAX_CODE_POINT + 1])
  readonly empty = this.intern('empty', [], [], false)
  readonly epsilon = this.intern('epsilon', [], [], true)
  readonly any = this.intern('any', [], [], true)

  spend(amount = 1): void {
    this.work += amount

    if (this.work > LIMITS.work) exceeded('compilation work', LIMITS.work)
  }

  private intern(
    kind: Kind,
    children: readonly Expression[],
    ranges: readonly Range[],
    nullable: boolean,
  ): Expression {
    this.spend(children.length + ranges.length + 1)
    const key = `${kind}:${children.map((child) => child.id).join(',')}:${ranges.map(([a, b]) => `${a}-${b}`).join(',')}`
    const existing = this.interned.get(key)

    if (existing) return existing

    if (this.interned.size >= LIMITS.nodes) exceeded('expression count', LIMITS.nodes)
    let depth = 1

    for (const child of children) depth = Math.max(depth, child.depth + 1)

    if (depth > LIMITS.depth) exceeded('expression depth', LIMITS.depth)
    const expression = { id: this.interned.size, kind, children, ranges, nullable, depth }
    this.interned.set(key, expression)

    return expression
  }

  chars(ranges: readonly Range[]): Expression {
    this.spend(ranges.length)
    const normalized = normalizeRanges(ranges)

    if (!normalized.length) return this.empty

    for (const [lower, upper] of normalized) {
      this.boundaries.add(lower)
      this.boundaries.add(upper + 1)
    }

    if (this.boundaries.size - 1 > LIMITS.alphabet)
      exceeded('character partition count', LIMITS.alphabet)

    return this.intern('chars', [], normalized, false)
  }

  literal(text: string): Expression {
    const children: Expression[] = []

    for (const character of text) {
      const point = character.codePointAt(0)!
      children.push(this.chars([[point, point]]))
    }

    return this.concat(children)
  }

  private combine(kind: 'union' | 'intersection', expressions: readonly Expression[]): Expression {
    const isUnion = kind === 'union'
    const identity = isUnion ? this.empty : this.any
    const absorbing = isUnion ? this.any : this.empty
    const children = new Map<number, Expression>()

    for (const expression of expressions) {
      this.spend()

      if (expression === absorbing) return absorbing

      if (expression === identity) continue
      const parts = expression.kind === kind ? expression.children : [expression]
      this.spend(parts.length)

      for (const part of parts) children.set(part.id, part)
    }

    if (!children.size) return identity

    for (const child of children.values()) {
      if (child.kind === 'not' && children.has(child.children[0]!.id)) return absorbing
    }

    const ordered = [...children.values()].sort((a, b) => a.id - b.id)

    if (ordered.length === 1) return ordered[0]!

    const nullable = isUnion
      ? ordered.some((child) => child.nullable)
      : ordered.every((child) => child.nullable)

    return this.intern(kind, ordered, [], nullable)
  }

  union(expressions: readonly Expression[]): Expression {
    return this.combine('union', expressions)
  }

  intersection(expressions: readonly Expression[]): Expression {
    return this.combine('intersection', expressions)
  }

  concat(expressions: readonly Expression[]): Expression {
    const children: Expression[] = []

    for (const expression of expressions) {
      this.spend()

      if (expression === this.empty) return this.empty

      if (expression === this.epsilon) continue
      const parts = expression.kind === 'concat' ? expression.children : [expression]
      this.spend(parts.length)

      if (children.length + parts.length > LIMITS.sequence)
        exceeded('concatenation length', LIMITS.sequence)

      for (const part of parts) children.push(part)
    }

    if (!children.length) return this.epsilon

    if (children.length === 1) return children[0]!

    return this.intern(
      'concat',
      children,
      [],
      children.every((child) => child.nullable),
    )
  }

  not(expression: Expression): Expression {
    if (expression === this.empty) return this.any

    if (expression === this.any) return this.empty

    if (expression.kind === 'not') return expression.children[0]!

    return this.intern('not', [expression], [], !expression.nullable)
  }

  star(expression: Expression): Expression {
    if (expression === this.empty || expression === this.epsilon) return this.epsilon

    if (expression === this.any || expression.kind === 'star') return expression

    return this.intern('star', [expression], [], true)
  }

  repeat(expression: Expression, minimum: number, maximum: number | undefined): Expression {
    if (minimum > LIMITS.repeat || (maximum !== undefined && maximum > LIMITS.repeat))
      exceeded('repetition', LIMITS.repeat)
    const children = Array<Expression>(minimum).fill(expression)

    if (maximum === undefined) children.push(this.star(expression))
    else {
      const optional = this.union([this.epsilon, expression])

      for (let index = minimum; index < maximum; index++) children.push(optional)
    }

    return this.concat(children)
  }

  derivative(expression: Expression, point: number, partition: number): Expression {
    this.spend()
    const key = `${expression.id}:${partition}`
    const cached = this.derivatives.get(key)

    if (cached) return cached
    const derive = (child: Expression) => this.derivative(child, point, partition)
    // A plain dispatch on purpose: `Match` arms can only close over per-call values, so a matcher
    // here allocates once per derivative. Measured on the six-pattern compile benchmark, that cost
    // about 40% of regex-compile throughput (1200 -> 725 compiles/s). `Expression` is also a single
    // type carrying a literal `kind`, not a union of shapes, so exhaustiveness would buy nothing.
    let result: Expression

    switch (expression.kind) {
      case 'empty':
      case 'epsilon':
        result = this.empty
        break
      case 'any':
        result = this.any
        break
      case 'chars':
        this.spend(expression.ranges.length)
        result = expression.ranges.some(([lower, upper]) => lower <= point && point <= upper)
          ? this.epsilon
          : this.empty
        break
      case 'union':
        result = this.union(expression.children.map(derive))
        break
      case 'intersection':
        result = this.intersection(expression.children.map(derive))
        break
      case 'not':
        result = this.not(derive(expression.children[0]!))
        break
      case 'star':
        result = this.concat([derive(expression.children[0]!), expression])
        break
      case 'concat': {
        const alternatives: Expression[] = []

        for (let index = 0; index < expression.children.length; index++) {
          const child = expression.children[index]!
          this.spend(expression.children.length - index)
          alternatives.push(this.concat([derive(child), ...expression.children.slice(index + 1)]))

          if (!child.nullable) break
        }

        result = this.union(alternatives)
        break
      }
    }

    this.derivatives.set(key, result)

    return result
  }
}

function stripZeros(value: string): string {
  let index = 0

  while (index < value.length - 1 && value[index] === '0') index++

  return value.slice(index)
}

function compareDecimals(left: string, right: string): number {
  return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0)
}

// A digit-prefix DAG avoids enumerating every integer in an interval.
function fixedInterval(factory: Expressions, lower: string, upper: string): Expression {
  const memo = new Map<string, Expression>()

  const visit = (index: number, lowerTight: boolean, upperTight: boolean): Expression => {
    factory.spend()

    if (index === lower.length) return factory.epsilon
    const key = `${index}:${lowerTight}:${upperTight}`
    const cached = memo.get(key)

    if (cached) return cached
    const low = lowerTight ? Number(lower[index]) : 0
    const high = upperTight ? Number(upper[index]) : 9
    const choices: Expression[] = []

    for (let digit = low; digit <= high; digit++) {
      choices.push(
        factory.concat([
          factory.chars([[48 + digit, 48 + digit]]),
          visit(index + 1, lowerTight && digit === low, upperTight && digit === high),
        ]),
      )
    }

    const result = factory.union(choices)
    memo.set(key, result)

    return result
  }

  return visit(0, true, true)
}

function numericInterval(factory: Expressions, first: string, last: string): Expression {
  if (Math.max(first.length, last.length) > LIMITS.intervalDigits)
    exceeded('interval digit count', LIMITS.intervalDigits)
  let lower = stripZeros(first)
  let upper = stripZeros(last)

  if (compareDecimals(lower, upper) > 0) [lower, upper] = [upper, lower]

  if (first.length === last.length) {
    return fixedInterval(
      factory,
      lower.padStart(first.length, '0'),
      upper.padStart(first.length, '0'),
    )
  }

  const choices: Expression[] = []

  for (let width = lower.length; width <= upper.length; width++) {
    const from = width === lower.length ? lower : `1${'0'.repeat(width - 1)}`
    const to = width === upper.length ? upper : '9'.repeat(width)
    choices.push(fixedInterval(factory, from, to))
  }

  return factory.concat([factory.star(factory.literal('0')), factory.union(choices)])
}

const RESERVED = '|&?*+{}()[]~.#@"<>\\'

class RegexParser {
  private position = 0
  private nesting = 0

  constructor(
    private readonly pattern: string,
    private readonly factory: Expressions,
  ) {}

  private fail(message: string): never {
    throw new RegexSyntaxError({
      message: `${message} at regex offset ${this.position}.`,
    })
  }

  private peek(): string {
    const point = this.pattern.codePointAt(this.position)

    return point === undefined ? '' : String.fromCodePoint(point)
  }

  private take(): string {
    const character = this.peek()

    if (!character) this.fail('Expected a character')
    this.position += character.length

    return character
  }

  private match(character: string): boolean {
    if (this.peek() !== character) return false
    this.position += character.length

    return true
  }

  private expect(character: string): void {
    if (!this.match(character)) this.fail(`Expected '${character}'`)
  }

  parse(): Expression {
    if (this.pattern.length > LIMITS.pattern) exceeded('pattern length', LIMITS.pattern)

    if (!this.pattern.length) return this.factory.epsilon
    const expression = this.union()

    if (this.peek()) this.fail(`Unexpected '${this.peek()}'`)

    return expression
  }

  private union(): Expression {
    const expressions = [this.intersection()]

    while (this.match('|')) expressions.push(this.intersection())

    return this.factory.union(expressions)
  }

  private intersection(): Expression {
    const expressions = [this.concat()]

    while (this.match('&')) expressions.push(this.concat())

    return this.factory.intersection(expressions)
  }

  private concat(): Expression {
    const expressions: Expression[] = []

    while (this.peek() && !'|&)'.includes(this.peek())) expressions.push(this.repeat())

    if (!expressions.length) this.fail('Expected a regex expression')

    return this.factory.concat(expressions)
  }

  private repeat(): Expression {
    let expression = this.complement()

    while (true) {
      if (this.match('?')) expression = this.factory.union([this.factory.epsilon, expression])
      else if (this.match('*')) expression = this.factory.star(expression)
      else if (this.match('+'))
        expression = this.factory.concat([expression, this.factory.star(expression)])
      else if (this.match('{')) {
        const minimum = this.count()
        let maximum: number | undefined = minimum

        if (this.match(',')) maximum = this.peek() === '}' ? undefined : this.count()
        this.expect('}')

        if (maximum !== undefined && minimum > maximum)
          this.fail('Repetition minimum exceeds maximum')
        expression = this.factory.repeat(expression, minimum, maximum)
      } else return expression
    }
  }

  private count(): number {
    const digits = this.decimal()
    const count = Number(digits)

    if (!Number.isSafeInteger(count) || count > LIMITS.repeat) exceeded('repetition', LIMITS.repeat)

    return count
  }

  private decimal(): string {
    const start = this.position

    while (this.peek() >= '0' && this.peek() <= '9' && this.peek()) this.take()

    if (this.position === start) this.fail('Expected decimal digits')

    return this.pattern.slice(start, this.position)
  }

  private enter(): void {
    this.nesting++

    if (this.nesting > LIMITS.nesting) exceeded('nesting', LIMITS.nesting)
  }

  private complement(): Expression {
    if (!this.match('~')) return this.atom()
    this.enter()
    const expression = this.factory.not(this.complement())
    this.nesting--

    return expression
  }

  private atom(): Expression {
    if (this.match('(')) {
      this.enter()
      const expression = this.match(')') ? this.factory.epsilon : this.group()
      this.nesting--

      return expression
    }

    if (this.match('[')) return this.characterClass()

    if (this.match('.')) return this.factory.chars([[0, MAX_CODE_POINT]])

    if (this.match('#')) return this.factory.empty

    if (this.match('@')) return this.factory.any

    if (this.match('"')) {
      const start = this.position

      while (this.peek() && this.peek() !== '"') this.take()
      const value = this.pattern.slice(start, this.position)
      this.expect('"')

      return this.factory.literal(value)
    }

    if (this.match('<')) {
      const lower = this.decimal()
      this.expect('-')
      const upper = this.decimal()
      this.expect('>')

      return numericInterval(this.factory, lower, upper)
    }

    const point = this.character()

    return this.factory.chars([[point, point]])
  }

  private group(): Expression {
    const expression = this.union()
    this.expect(')')

    return expression
  }

  private character(): number {
    if (this.match('\\')) return this.take().codePointAt(0)!
    const character = this.peek()

    if (!character || RESERVED.includes(character))
      this.fail('Expected a literal character; escape reserved characters')

    return this.take().codePointAt(0)!
  }

  private characterClass(): Expression {
    const negated = this.match('^')
    const ranges: Range[] = []

    while (this.peek() && this.peek() !== ']') {
      const lower = this.character()
      const upper = this.match('-') ? this.character() : lower

      if (lower > upper) this.fail('Character range minimum exceeds maximum')
      ranges.push([lower, upper])
    }

    if (!ranges.length) this.fail('Expected a nonempty character class')
    this.expect(']')
    const normalized = normalizeRanges(ranges)

    return this.factory.chars(negated ? invertRanges(normalized) : normalized)
  }
}

interface Dfa {
  readonly boundaries: readonly number[]
  readonly transitions: readonly Uint16Array[]
  readonly accepting: readonly boolean[]
}

function determinize(factory: Expressions, initial: Expression): Dfa {
  const boundaries = [...factory.boundaries].sort((a, b) => a - b)
  const partitions = boundaries.length - 1
  const states = [initial]
  const indexes = new Map([[initial.id, 0]])
  const transitions: Uint16Array[] = []
  const accepting: boolean[] = []

  for (let index = 0; index < states.length; index++) {
    if ((index + 1) * partitions > LIMITS.transitions)
      exceeded('transition count', LIMITS.transitions)
    const state = states[index]!
    accepting.push(state.nullable)
    const row = new Uint16Array(partitions)

    for (let partition = 0; partition < partitions; partition++) {
      const next = factory.derivative(state, boundaries[partition]!, partition)
      let target = indexes.get(next.id)

      if (target === undefined) {
        if (states.length >= LIMITS.states) exceeded('state count', LIMITS.states)
        target = states.length
        indexes.set(next.id, target)
        states.push(next)
      }

      row[partition] = target
    }

    transitions.push(row)
  }

  return { boundaries, transitions, accepting }
}

function partitionOf(boundaries: readonly number[], point: number): number {
  let lower = 0
  let upper = boundaries.length - 1

  while (lower + 1 < upper) {
    const middle = (lower + upper) >>> 1

    if (boundaries[middle]! <= point) lower = middle
    else upper = middle
  }

  return lower
}

// A matcher is read-only over its DFA, so one automaton serves every call for the same pattern.
// Editor parsing validates and then compiles the same pattern, so the cap keeps memory bounded.
const compiled = new Map<string, (term: string) => boolean>()

const CACHE_LIMIT = 64

export function compileRegex(pattern: string): (term: string) => boolean {
  const cached = compiled.get(pattern)

  if (cached) return cached

  const factory = new Expressions()
  const expression = new RegexParser(pattern, factory).parse()
  const dfa = determinize(factory, expression)

  const matcher = (term: string): boolean => {
    let state = 0

    for (const character of term) {
      state = dfa.transitions[state]![partitionOf(dfa.boundaries, character.codePointAt(0)!)]!
    }

    return dfa.accepting[state]!
  }

  if (compiled.size >= CACHE_LIMIT) compiled.clear()
  compiled.set(pattern, matcher)

  return matcher
}

/** Validate syntax and the same compilation limits used by compileRegex. */
export function validateRegex(pattern: string): string | undefined {
  try {
    compileRegex(pattern)

    return undefined
  } catch (error) {
    if (error instanceof RegexSyntaxError) return error.message
    throw error
  }
}
