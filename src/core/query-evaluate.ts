import { currentDate } from './date'
import {
  findQueryField,
  resolveDateValue,
  type QueryField,
  type QueryFieldValue,
} from './query-fields'
import type { CompareOperator, QueryNode, QueryValue } from './query-types'

type Predicate<T> = (record: T) => boolean

function compare(
  operator: CompareOperator,
  actual: number | string,
  expected: number | string,
): boolean {
  switch (operator) {
    case '>':
      return actual > expected
    case '>=':
      return actual >= expected
    case '<':
      return actual < expected
    case '<=':
      return actual <= expected
  }
}

function orderedMatcher(value: QueryValue, convert: (raw: string) => number | string | undefined) {
  if (value.kind === 'range') {
    const from = convert(value.from)
    const to = convert(value.to)

    return (actual: number | string) =>
      from !== undefined && to !== undefined && actual >= from && actual <= to
  }

  const expected = convert(value.raw)

  return (actual: number | string) =>
    expected !== undefined &&
    (value.kind === 'compare' ? compare(value.operator, actual, expected) : actual === expected)
}

function valueMatcher<T>(
  field: QueryField<T>,
  value: QueryValue,
  today: string,
): (actual: QueryFieldValue) => boolean {
  if (field.type === 'number') {
    const match = orderedMatcher(value, (raw) =>
      Number.isFinite(Number(raw)) ? Number(raw) : undefined,
    )

    return (actual) =>
      actual !== null &&
      actual !== undefined &&
      String(actual).trim() !== '' &&
      Number.isFinite(Number(actual)) &&
      match(Number(actual))
  }

  if (field.type === 'date') {
    const match = orderedMatcher(value, (raw) => resolveDateValue(raw, today))

    return (actual) => actual !== null && actual !== undefined && match(String(actual).slice(0, 10))
  }

  if (value.kind !== 'term') return () => false

  if (field.type === 'boolean') {
    return (actual) =>
      actual !== null &&
      actual !== undefined &&
      String(actual).toLowerCase() === value.raw.toLowerCase()
  }

  // Compile literal pieces once; avoid regex backtracking on adversarial wildcard patterns.
  const parts = value.raw.toLowerCase().split('*')
  const first = parts[0] ?? ''
  const last = parts.at(-1) ?? ''
  const middle = parts.slice(1, -1)

  return (actual) => {
    if (actual === null || actual === undefined) return false
    const text = String(actual).toLowerCase()

    if (parts.length === 1) return text === first

    if (!text.startsWith(first) || !text.endsWith(last)) return false
    let cursor = first.length
    const end = text.length - last.length

    for (const part of middle) {
      const index = text.indexOf(part, cursor)

      if (index < 0 || index + part.length > end) return false
      cursor = index + part.length
    }

    return cursor <= end
  }
}

/** Compile an AST into a reusable predicate. Validate parsed input before using a partial AST. */
export function compileQuery<T>(
  node: QueryNode | undefined,
  fields: readonly QueryField<T>[],
  today = currentDate(),
): Predicate<T> {
  if (!node) return () => true

  switch (node.type) {
    case 'and': {
      const predicates = node.children.map((child) => compileQuery(child, fields, today))

      return (record) => predicates.every((predicate) => predicate(record))
    }

    case 'or': {
      const predicates = node.children.map((child) => compileQuery(child, fields, today))

      return (record) => predicates.some((predicate) => predicate(record))
    }

    case 'not': {
      const predicate = compileQuery(node.node, fields, today)

      return (record) => !predicate(record)
    }

    case 'term': {
      if (node.field === undefined) {
        const searchable = fields.filter((field) => field.freeText)

        const needles = node.values.flatMap((value) =>
          value.kind === 'term' ? [value.raw.toLowerCase()] : [],
        )

        return (record) =>
          searchable.some((field) => {
            const actual = field.read(record)

            return (
              actual != null &&
              needles.some((needle) => String(actual).toLowerCase().includes(needle))
            )
          })
      }

      const field = findQueryField(fields, node.field)

      if (!field) return () => false
      const matchers = node.values.map((value) => valueMatcher(field, value, today))

      return (record) => {
        const actual = field.read(record)

        return matchers.some((match) => match(actual))
      }
    }
  }
}

export function matchesQuery<T>(
  node: QueryNode,
  fields: readonly QueryField<T>[],
  record: T,
  today = currentDate(),
): boolean {
  return compileQuery(node, fields, today)(record)
}

export function filterRecords<T>(
  node: QueryNode | undefined,
  fields: readonly QueryField<T>[],
  records: readonly T[],
  today = currentDate(),
): readonly T[] {
  return node ? records.filter(compileQuery(node, fields, today)) : records
}
