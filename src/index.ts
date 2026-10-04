// scripts/build.ts emits the published 'use client' boundary.

export { createQueryEngine, type QueryEngine } from './query-engine-adapter'

export {
  QueryConfigurationError,
  type QueryEngineOptions,
  type CompiledQuery,
  compileQuery,
  filterRecords,
  matchesQuery,
  parseQuery,
  hasErrors,
  tokenize,
  tokenValue,
  getSuggestions,
  applySuggestion,
  type QueryField,
  type QueryFieldType,
  type QueryFieldValue,
  type ParsedQuery,
  type QueryDiagnostic,
  type QueryNode,
  type QueryToken,
  type QueryValue,
  type TokenRole,
  type QueryTermSpan,
  type CompareOperator,
  type DiagnosticSeverity,
  type TokenKind,
  type Suggestion,
  type SuggestionList,
  type SuggestionKind,
  type SuggestionOptions,
} from './core'

export {
  useQuerySearch,
  type UseQuerySearchOptions,
  type QuerySearchState,
} from './use-query-search'

export {
  useQueryEditor,
  type UseQueryEditorOptions,
  type QueryEditorState,
} from './use-query-editor'

export { useQueryContext, type QueryContextValue } from './query-context'

export {
  Query,
  type QueryRootProps,
  type QueryInputProps,
  type QuerySuggestionsProps,
  type QueryOptionProps,
} from './query'
