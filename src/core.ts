export {
  QueryEngine,
  QueryConfigurationError,
  InvalidQueryError,
  type QueryEngineOptions,
  type CompiledQuery,
  type SearchAdapter,
} from './core/query-engine'

export { toQueryEngineAdapter } from './query-engine-adapter'

export { compileQuery, filterRecords, matchesQuery } from './core/query-evaluate'

export { parseQuery, hasErrors } from './core/query-parser'

export { tokenize, tokenValue } from './core/query-tokenizer'

export {
  getSuggestions,
  applySuggestion,
  type Suggestion,
  type SuggestionList,
  type SuggestionKind,
  type SuggestionOptions,
} from './core/query-suggest'

export type { QueryField, QueryFieldType, QueryFieldValue } from './core/query-fields'

export type {
  ParsedQuery,
  QueryDiagnostic,
  QueryNode,
  QueryToken,
  QueryValue,
  TokenRole,
  QueryTermSpan,
  CompareOperator,
  DiagnosticSeverity,
  TokenKind,
} from './core/query-types'
