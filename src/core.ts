export {
  QueryEngine,
  QueryConfigurationError,
  InvalidQueryError,
  type QueryEngineOptions,
  type CompiledQuery,
  type SearchAdapter,
} from './core/engine'

export { toQueryEngineAdapter } from './engine-adapter'

export { QueryTranslationError, QueryValueError, RegexSyntaxError } from './core/errors'

export {
  compileQuery,
  tryCompileQuery,
  filterRecords,
  matchesQuery,
  scalarText,
} from './core/evaluate'

export { facetCounts, type FacetCounts, type FacetOptions } from './core/facets'

export { fieldValues, readPath, findQueryField, closestFieldKey } from './core/fields'

export {
  listClauses,
  removeClause,
  toggleClause,
  type Clause,
  type ClauseSelector,
} from './core/clauses'

export {
  and,
  escapeFieldName,
  escapeTerm,
  fieldClause,
  not,
  or,
  type FieldClause,
} from './core/build'

export { parseQuery, hasErrors, type ParseOptions, type UnknownFieldMode } from './core/parser'

export { stringifyQuery } from './core/stringify'

export { tokenize, tokenValue } from './core/tokenizer'

export { parseDate, parseNumber, type DateWindow, type DatePrecision } from './core/analysis'

export {
  getSuggestions,
  applySuggestion,
  type Suggestion,
  type SuggestionList,
  type SuggestionKind,
  type SuggestionOptions,
} from './core/suggest'

export type { QueryField, QueryFieldType, QueryFieldValue, QueryFieldScalar } from './core/fields'

export type {
  ParsedQuery,
  QueryDiagnostic,
  QueryNode,
  QueryClause,
  QueryToken,
  QueryValue,
  TokenRole,
  QueryTermSpan,
  DiagnosticSeverity,
  TokenKind,
} from './core/types'
