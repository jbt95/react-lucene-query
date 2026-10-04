import { createContext, useContext } from 'react'
import type { ParsedQuery } from './core'
import type { QueryEditorState } from './use-query-editor'

export type QueryContextValue = QueryEditorState & {
  readonly parse: (value: string) => ParsedQuery
}

export const QueryContext = createContext<QueryContextValue | null>(null)

export function useQueryContext(): QueryContextValue {
  const state = useContext(QueryContext)

  if (!state) throw new Error('Query primitives must be rendered inside Query.Root')

  return state
}
