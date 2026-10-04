export type TokenKind =
  | 'field'
  | 'colon'
  | 'text'
  | 'quoted'
  | 'operator'
  | 'minus'
  | 'lparen'
  | 'rparen'
  | 'lbracket'
  | 'rbracket'
  | 'compare'

export type QueryToken = {
  readonly kind: TokenKind
  readonly text: string
  readonly start: number
  readonly end: number
  // Only meaningful for `quoted`: false while the closing quote has not been typed yet.
  readonly closed?: boolean
}

// What a token means once the parser has seen it in context. The highlighter colours by role, so
// the same word reads differently as a field name, a number, or a stray token.
export type TokenRole =
  | 'field'
  | 'field-unknown'
  | 'colon'
  | 'value-text'
  | 'value-number'
  | 'value-date'
  | 'value-boolean'
  | 'value-enum'
  | 'value-invalid'
  | 'free-text'
  | 'operator'
  | 'negation'
  | 'paren'
  | 'bracket'
  | 'range-to'
  | 'compare'
  | 'unexpected'

export type CompareOperator = '>' | '>=' | '<' | '<='

export type QueryValue =
  | { readonly kind: 'term'; readonly raw: string }
  | { readonly kind: 'compare'; readonly operator: CompareOperator; readonly raw: string }
  | { readonly kind: 'range'; readonly from: string; readonly to: string }

// Several values on one term (`wot:(Air OR Sea)`) match when any of them does.
export type QueryNode =
  | {
      readonly type: 'term'
      readonly field: string | undefined
      readonly values: readonly QueryValue[]
    }
  | { readonly type: 'not'; readonly node: QueryNode }
  | { readonly type: 'and' | 'or'; readonly children: readonly QueryNode[] }

export type DiagnosticSeverity = 'error' | 'warning'

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
