// scripts/build.ts emits the published 'use client' boundary.

export { createQueryEngine, type QueryEngine } from './engine-adapter'

export {
  QueryConfigurationError,
  type QueryEngineOptions,
  type CompiledQuery,
  compileQuery,
  tryCompileQuery,
  facetCounts,
  fieldValues,
  filterRecords,
  matchesQuery,
  parseDate,
  parseNumber,
  parseQuery,
  readPath,
  stringifyQuery,
  hasErrors,
  tokenize,
  tokenValue,
  getSuggestions,
  applySuggestion,
  and,
  escapeFieldName,
  escapeTerm,
  fieldClause,
  listClauses,
  removeClause,
  not,
  or,
  toggleClause,
  QueryValueError,
  RegexSyntaxError,
  type Clause,
  type ClauseSelector,
  type DatePrecision,
  type DateWindow,
  type FacetCounts,
  type FacetOptions,
  type FieldClause,
  type ParseOptions,
  type QueryField,
  type QueryFieldScalar,
  type QueryFieldType,
  type QueryFieldValue,
  type ParsedQuery,
  type QueryDiagnostic,
  type QueryNode,
  type QueryClause,
  type QueryToken,
  type QueryValue,
  type TokenRole,
  type QueryTermSpan,
  type DiagnosticSeverity,
  type TokenKind,
  type Suggestion,
  type SuggestionList,
  type SuggestionKind,
  type SuggestionOptions,
  type UnknownFieldMode,
} from './core'

export {
  useQuerySearch,
  type UseQuerySearchOptions,
  type QuerySearchState,
  type QuerySearchStatus,
  type SearchError,
  type LocalSearchOptions,
  type AsyncSearchOptions,
} from './use-query-search'

export { useQueryUrlState, type UseQueryUrlStateOptions } from './use-query-url-state'

export {
  useQueryHistory,
  type UseQueryHistoryOptions,
  type QueryHistoryEntry,
  type QueryHistoryState,
} from './use-query-history'

export {
  useQueryEditor,
  type UseQueryEditorOptions,
  type QueryEditorState,
} from './use-query-editor'

export { useQueryContext, type QueryContextValue, type QueryFieldMeta } from './context'

export {
  Query,
  type QueryRootProps,
  type QueryInputProps,
  type QuerySuggestionsProps,
  type QueryOptionProps,
  type QueryChipsProps,
  type QueryFacetsProps,
  type QueryFacetValue,
} from './input'
