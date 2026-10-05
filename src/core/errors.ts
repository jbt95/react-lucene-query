import { Data } from 'effect'

/** An expected rejection by an output adapter; no backend work has been executed. */
export class QueryTranslationError extends Data.TaggedError('QueryTranslationError')<{
  readonly target: 'json' | 'postgres'
  readonly code:
    | 'invalid-query'
    | 'invalid-json'
    | 'query-limit'
    | 'unsupported-feature'
    | 'unmapped-field'
    | 'invalid-mapping'
    | 'invalid-value'
  readonly message: string
  readonly field?: string
  readonly feature?: string
}> {}

/**
 * A clause value or query node outside the domain the query language can express: a fuzzy distance
 * above two, an incomplete escape, a negative proximity, a boost that is not positive.
 *
 * The parser rejects these before compiling, so reaching one means the value came from a
 * hand-built node rather than parsed text. It is a typed error rather than a bare `RangeError` so
 * the engine can map it into its error channel instead of letting it escape as a defect.
 */
export class QueryValueError extends Data.TaggedError('QueryValueError')<{
  readonly message: string
}> {}

/**
 * The regular expression compiler's own limit and syntax failures. Carries the offset the pattern
 * failed at, so a diagnostic can point into the query text.
 */
export class RegexSyntaxError extends Data.TaggedError('RegexSyntaxError')<{
  readonly message: string
}> {}
