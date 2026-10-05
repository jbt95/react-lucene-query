import { createContext, useContext } from 'react'
import type { Clause, FacetOptions, ParsedQuery } from './core'
import type { QueryFieldType } from './core/fields'
import type { QueryEditorState } from './use-query-editor'

/** The serializable half of a field: enough to label chips and facets without the accessors. */
export type QueryFieldMeta = {
  readonly key: string
  readonly label: string
  readonly type: QueryFieldType
  readonly options?: readonly string[]
}

export type QueryContextValue = QueryEditorState & {
  readonly parse: (value: string) => ParsedQuery
  /** The query the results correspond to, which is not the draft being typed. */
  readonly applied: string
  readonly clauses: readonly Clause[]
  readonly fields: readonly QueryFieldMeta[]
  /** Value counts for one field among the records the applied query already selects. */
  readonly facets: (field: string, options?: FacetOptions) => ReadonlyMap<string, number>
  /** Edits the draft and applies it in one step, so a chip never leaves the query pending. */
  readonly applyText: (text: string) => void
}

export const QueryContext = createContext<QueryContextValue | null>(null)

export function useQueryContext(): QueryContextValue {
  const state = useContext(QueryContext)

  if (!state) throw new Error('Query primitives must be rendered inside Query.Root')

  return state
}
