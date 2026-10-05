export type TokenKind =
  | 'field'
  | 'colon'
  | 'text'
  | 'quoted'
  | 'regex'
  | 'operator'
  | 'plus'
  | 'minus'
  | 'lparen'
  | 'rparen'
  | 'lbracket'
  | 'rbracket'
  | 'lbrace'
  | 'rbrace'
  | 'tilde'
  | 'caret'

export type QueryToken = {
  readonly kind: TokenKind
  readonly text: string
  readonly start: number
  readonly end: number
  // False while the closing quote or regex delimiter has not been typed yet.
  readonly closed?: boolean
}

// Contextual token roles drive the editor highlighter.
export type TokenRole =
  | 'field'
  | 'field-unknown'
  | 'colon'
  | 'value-text'
  | 'value-invalid'
  | 'free-text'
  | 'operator'
  | 'negation'
  | 'paren'
  | 'bracket'
  | 'range-to'
  | 'modifier'
  | 'regex'
  | 'wildcard'
  | 'unexpected'

export type QueryValue =
  | { readonly kind: 'term'; readonly raw: string }
  | { readonly kind: 'phrase'; readonly raw: string; readonly proximity?: number }
  | { readonly kind: 'wildcard'; readonly raw: string }
  | { readonly kind: 'fuzzy'; readonly raw: string; readonly distance?: number }
  | { readonly kind: 'regex'; readonly raw: string }
  | {
      readonly kind: 'range'
      readonly from: string | undefined
      readonly to: string | undefined
      readonly includeLower: boolean
      readonly includeUpper: boolean
    }

export type QueryClause = {
  readonly occur: 'must' | 'should' | 'must-not'
  readonly node: QueryNode
}

export type QueryNode =
  | {
      readonly type: 'term'
      readonly field: string | undefined
      readonly value: QueryValue
      readonly boost?: number
    }
  | {
      readonly type: 'boolean'
      readonly clauses: readonly QueryClause[]
      readonly boost?: number
    }

/** The one list of severities. Both the type and the Schema that validates it derive from it. */
export const DIAGNOSTIC_SEVERITIES = ['error', 'warning'] as const

export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number]

export type QueryDiagnostic = {
  readonly start: number
  readonly end: number
  readonly message: string
  readonly severity: DiagnosticSeverity
}

// One `field:value` (or bare word) group; the highlighter draws it as a single chip.
export type QueryTermSpan = {
  readonly start: number
  readonly end: number
  readonly negated: boolean
  readonly invalid: boolean
}

export type ParsedQuery = {
  readonly text: string
  readonly tokens: readonly QueryToken[]
  // Parallel to `tokens`.
  readonly roles: readonly TokenRole[]
  readonly terms: readonly QueryTermSpan[]
  readonly diagnostics: readonly QueryDiagnostic[]
  readonly node: QueryNode | undefined
}
