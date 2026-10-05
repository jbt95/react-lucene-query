import { fieldClause } from './build'
import { hasErrors, parseQuery } from './parser'
import { stringifyQuery } from './stringify'
import type { QueryClause, QueryNode, QueryValue } from './types'

/** One flat condition of a parsed query, with the canonical text that reproduces exactly it. */
export type Clause = {
  readonly field: string | undefined
  readonly value: QueryValue
  readonly occur: QueryClause['occur']
  /** Canonical text of this clause alone, so a chip can re-render it verbatim. */
  readonly text: string
}

function termClause(node: QueryNode & { type: 'term' }, occur: QueryClause['occur']): Clause {
  return { field: node.field, value: node.value, occur, text: stringifyQuery(node) }
}

function collect(node: QueryNode, occur: QueryClause['occur'], into: Clause[]): void {
  if (node.type === 'term') {
    into.push(termClause(node, occur))

    return
  }

  for (const clause of node.clauses) collect(clause.node, clause.occur, into)
}

/**
 * Flattens an AST into its conditions, innermost occurrence included. Used to render removable
 * chips and to answer "is this filter already applied?".
 */
export function listClauses(node: QueryNode | undefined): readonly Clause[] {
  if (!node) return []
  const clauses: Clause[] = []

  collect(node, 'should', clauses)

  return clauses
}

function removeClauses(
  node: QueryNode | undefined,
  matches: (clause: Clause) => boolean,
  occur: QueryClause['occur'] = 'should',
): QueryNode | undefined {
  if (!node) return undefined

  if (node.type === 'term') return matches(termClause(node, occur)) ? undefined : node

  const kept = node.clauses.flatMap((clause) => {
    const next = removeClauses(clause.node, matches, clause.occur)

    return next === undefined ? [] : [{ ...clause, node: next }]
  })

  // A group that loses its last clause disappears too, rather than becoming unparseable.
  if (kept.length === 0) return undefined

  const only = kept[0]

  if (kept.length === 1 && only?.occur === 'should') return only.node

  return { ...node, clauses: kept }
}

/** Removes the exact parsed condition, including its modifiers and occurrence. */
export function removeClause(text: string, target: Clause): string {
  const parsed = parseQuery(text)

  if (hasErrors(parsed)) return text

  return stringifyQuery(
    removeClauses(
      parsed.node,
      (clause) =>
        clause.field === target.field &&
        clause.text === target.text &&
        clause.occur === target.occur,
    ),
  )
}

export type ClauseSelector = {
  readonly field: string
  readonly value: string
}

/** A quoted and an unquoted spelling of one value are the same condition, as they are in Lucene. */
function isSameCondition(clause: Clause, field: string, value: string): boolean {
  if (clause.field !== field) return false

  return (
    (clause.value.kind === 'term' || clause.value.kind === 'phrase') && clause.value.raw === value
  )
}

/**
 * Adds a condition, or removes it when the query already contains it. An unparseable query is
 * returned untouched rather than being rewritten into something else.
 */
export function toggleClause(text: string, { field, value }: ClauseSelector): string {
  const parsed = parseQuery(text)

  // Rewriting a query the parser rejects would silently replace what the user is typing.
  if (hasErrors(parsed)) return text

  if (!parsed.node) return fieldClause({ field, value })

  const matches = (clause: Clause) => isSameCondition(clause, field, value)

  if (listClauses(parsed.node).some(matches))
    return stringifyQuery(removeClauses(parsed.node, matches))

  const target = parseQuery(fieldClause({ field, value })).node

  if (!target) return text

  const existing =
    parsed.node.type === 'boolean' &&
    parsed.node.boost === undefined &&
    parsed.node.clauses.some((clause) => clause.occur === 'must')
      ? parsed.node.clauses
      : [{ occur: 'must' as const, node: parsed.node }]

  return stringifyQuery({
    type: 'boolean',
    clauses: [...existing, { occur: 'must', node: target }],
  })
}
