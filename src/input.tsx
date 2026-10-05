/* eslint-disable jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role -- ARIA combobox/listbox/options retain focus in the wrapped query editor; native select cannot provide this interaction. */
import {
  forwardRef,
  useCallback,
  useMemo,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import {
  facetCounts,
  listClauses,
  removeClause,
  toggleClause,
  type Clause,
  type FacetOptions,
  type ParsedQuery,
  type Suggestion,
  type SuggestionList,
} from './core'
import type { QueryEngine } from './engine-adapter'
import {
  QueryContext,
  useQueryContext,
  type QueryContextValue,
  type QueryFieldMeta,
} from './context'
import { useQueryEditor } from './use-query-editor'

const EMPTY_RECORDS: readonly never[] = []

export interface QueryRootProps<T> {
  readonly engine: QueryEngine<T>
  readonly records?: readonly T[]
  readonly value: string
  readonly parsed?: ParsedQuery
  /** The applied query. Chips and facets describe results, so they default to the draft. */
  readonly applied?: string
  readonly onValueChange: (value: string) => void
  readonly onSubmit: (value: string) => boolean
  readonly getSuggestions?: (value: string, caret: number) => SuggestionList | undefined
  readonly children: ReactNode
}

function Root<T>({
  engine,
  records = EMPTY_RECORDS,
  value,
  parsed,
  applied,
  onValueChange,
  onSubmit,
  getSuggestions,
  children,
}: QueryRootProps<T>) {
  const suggest = useCallback(
    (text: string, caret: number) => engine.suggest(text, caret, records),
    [engine, records],
  )

  const parsedValue = useMemo(() => parsed ?? engine.parse(value), [engine, parsed, value])
  const appliedValue = applied ?? value

  const appliedParsed = useMemo(
    () => (applied === undefined ? parsedValue : engine.parse(appliedValue)),
    [applied, appliedValue, engine, parsedValue],
  )

  const editor = useQueryEditor({
    value,
    parsed: parsedValue,
    onValueChange,
    onSubmit,
    getSuggestions: getSuggestions ?? suggest,
  })

  const fields = useMemo<readonly QueryFieldMeta[]>(
    () => engine.fields.map(({ key, label, type, options }) => ({ key, label, type, options })),
    [engine],
  )

  const clauses = useMemo(() => listClauses(appliedParsed.node), [appliedParsed])

  const compiled = useMemo(() => engine.compile(appliedValue), [appliedValue, engine])

  const facets = useCallback(
    (field: string, options?: FacetOptions) =>
      facetCounts(compiled.test, engine.fields, records, { ...options, keys: [field] }).get(
        field,
      ) ?? new Map<string, number>(),
    [compiled, engine, records],
  )

  const applyText = useCallback(
    (text: string) => {
      onValueChange(text)
      onSubmit(text)
    },
    [onSubmit, onValueChange],
  )

  return (
    <QueryContext.Provider
      value={{
        ...editor,
        parse: engine.parse,
        applied: appliedValue,
        clauses,
        fields,
        facets,
        applyText,
      }}
    >
      {children}
    </QueryContext.Provider>
  )
}

/** Bring your own controller, including a custom suggestion source. */
function Provider({
  value,
  children,
}: {
  readonly value: QueryContextValue
  readonly children: ReactNode
}) {
  return <QueryContext.Provider value={value}>{children}</QueryContext.Provider>
}

export type QueryInputProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'defaultValue' | 'onChange' | 'children'
>

const Input = forwardRef<HTMLTextAreaElement, QueryInputProps>(function QueryInput(
  { onKeyDown, onSelect, onFocus, onBlur, id, 'aria-describedby': describedBy, ...props },
  ref,
) {
  const editor = useQueryContext()

  const setInputRef = editor.setInputRef

  const setInput = useCallback(
    (node: HTMLTextAreaElement | null) => {
      setInputRef(node)

      if (ref && 'current' in ref) ref.current = node
      else ref?.(node)
    },
    [setInputRef, ref],
  )

  // A wrapped query editor needs a textarea combobox; native select/datalist cannot replace it.
  // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
  return (
    <textarea
      {...props}
      ref={setInput}
      id={id ?? editor.inputId}
      rows={props.rows ?? 1}
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={editor.open}
      aria-controls={editor.open ? editor.listId : undefined}
      aria-activedescendant={
        editor.open && editor.activeIndex >= 0 ? editor.optionId(editor.activeIndex) : undefined
      }
      aria-describedby={[describedBy, editor.diagnosticsId].filter(Boolean).join(' ')}
      aria-invalid={editor.hasError}
      spellCheck={props.spellCheck ?? false}
      autoComplete="off"
      value={editor.value}
      onChange={(event) => {
        const text = event.currentTarget.value.replaceAll(/[\r\n]+/g, ' ')
        editor.onValueChange(text)
        editor.setCaret(Math.min(event.currentTarget.selectionStart, text.length))
      }}
      onSelect={(event) => {
        onSelect?.(event)
        editor.setCaret(event.currentTarget.selectionStart)
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event)

        if (!event.defaultPrevented) editor.onKeyDown(event)
      }}
      onFocus={(event) => {
        onFocus?.(event)
        editor.setFocused(true)
        editor.setCaret(event.currentTarget.selectionStart)
      }}
      onBlur={(event) => {
        onBlur?.(event)
        editor.setFocused(false)
      }}
    />
  )
})

export interface QuerySuggestionsProps extends Omit<HTMLAttributes<HTMLUListElement>, 'children'> {
  readonly children?: (suggestions: readonly Suggestion[]) => ReactNode
}

function Suggestions({ children, ...props }: QuerySuggestionsProps) {
  const editor = useQueryContext()

  if (!editor.open || !editor.suggestions) return null

  // Custom keyboard-managed completion popup, not a native select.
  // eslint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role
  return (
    <ul
      {...props}
      id={editor.listId}
      role="listbox"
      aria-label={props['aria-label'] ?? editor.suggestions.title}
    >
      {children
        ? children(editor.suggestions.items)
        : editor.suggestions.items.map((item, index) => (
            <Option key={item.id} item={item} index={index}>
              {item.label}
            </Option>
          ))}
    </ul>
  )
}

export interface QueryOptionProps extends HTMLAttributes<HTMLLIElement> {
  readonly item: Suggestion
  readonly index: number
}

function Option({ item, index, onMouseDown, onMouseMove, children, ...props }: QueryOptionProps) {
  const editor = useQueryContext()

  // Focus stays in the combobox and aria-activedescendant addresses these options.
  // eslint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role
  return (
    <li
      {...props}
      id={editor.optionId(index)}
      role="option"
      aria-selected={index === editor.activeIndex}
      data-active={index === editor.activeIndex ? '' : undefined}
      onMouseDown={(event) => {
        onMouseDown?.(event)

        if (!event.defaultPrevented) {
          event.preventDefault()
          editor.accept(item)
        }
      }}
      onMouseMove={(event) => {
        onMouseMove?.(event)
        editor.highlight(index)
      }}
    >
      {children ?? item.label}
    </li>
  )
}

function Diagnostics(props: HTMLAttributes<HTMLUListElement>) {
  const editor = useQueryContext()

  return (
    <ul {...props} id={editor.diagnosticsId} aria-live="polite" aria-atomic="true">
      {editor.parsed.diagnostics.map((diagnostic, index) => (
        <li key={`${diagnostic.start}-${index}`} data-severity={diagnostic.severity}>
          {diagnostic.message}
        </li>
      ))}
    </ul>
  )
}

function Submit({
  onClick,
  children = 'Search',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const editor = useQueryContext()

  return (
    <button
      {...props}
      type="button"
      onClick={(event) => {
        onClick?.(event)

        if (!event.defaultPrevented) editor.submit()
      }}
    >
      {children}
    </button>
  )
}

function Clear({ onClick, children = 'Clear', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const editor = useQueryContext()

  return (
    <button
      {...props}
      type="button"
      onClick={(event) => {
        onClick?.(event)

        if (!event.defaultPrevented) editor.clear()
      }}
    >
      {children}
    </button>
  )
}

/** Syntax roles only; styling belongs to the consumer. Do not change glyph metrics in mirrored text. */
function Highlight({
  placeholder,
  ...props
}: HTMLAttributes<HTMLDivElement> & { readonly placeholder?: string }) {
  const { parsed } = useQueryContext()
  const segments: ReactNode[] = []
  let cursor = 0

  for (const [index, token] of parsed.tokens.entries()) {
    if (token.start > cursor) segments.push(parsed.text.slice(cursor, token.start))
    segments.push(
      <span key={token.start} data-role={parsed.roles[index]}>
        {token.text}
      </span>,
    )
    cursor = token.end
  }

  if (cursor < parsed.text.length) segments.push(parsed.text.slice(cursor))

  return (
    <div {...props} aria-hidden="true">
      {parsed.text ? segments : <span data-placeholder="">{placeholder}</span>}
      {'\u200b'}
    </div>
  )
}

export interface QueryChipsProps extends Omit<HTMLAttributes<HTMLUListElement>, 'children'> {
  readonly children?: (clauses: readonly Clause[]) => ReactNode
}

function clauseText(clause: Clause, labels: ReadonlyMap<string, string>): string {
  const label = clause.field === undefined ? undefined : labels.get(clause.field)

  return label === undefined
    ? clause.text
    : `${label}: ${clause.text.split(':').slice(1).join(':').trim()}`
}

/** The applied query as removable chips. A click toggles that condition off and reapplies. */
function Chips({ children, ...props }: QueryChipsProps) {
  const editor = useQueryContext()

  if (editor.clauses.length === 0) return null

  const labels = new Map(editor.fields.map((field) => [field.key, field.label]))
  const clauses = editor.clauses

  // Custom keyboard-managed chip list, not a native select.
  // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role
    <ul {...props} aria-label={props['aria-label'] ?? 'Applied filters'}>
      {children
        ? children(clauses)
        : clauses.map((clause) => {
            const removable = clause.field !== undefined

            return (
              <li key={clause.text} data-clause={clause.text} data-occur={clause.occur}>
                <button
                  type="button"
                  disabled={!removable}
                  onClick={() => {
                    if (clause.field === undefined) return
                    editor.applyText(removeClause(editor.applied, clause))
                  }}
                >
                  {clauseText(clause, labels)}
                </button>
              </li>
            )
          })}
    </ul>
  )
}

export interface QueryFacetValue {
  readonly value: string
  readonly count: number
  readonly selected: boolean
}

export interface QueryFacetsProps extends Omit<HTMLAttributes<HTMLUListElement>, 'children'> {
  readonly field: string
  /** Values shown, most frequent first. Defaults to 10. */
  readonly limit?: number
  readonly children?: (values: readonly QueryFacetValue[]) => ReactNode
}

/**
 * Value counts for one field among the records the applied query selects, so an option that would
 * return nothing is not offered. A click toggles that condition into the applied query.
 */
function Facets({ field, limit = 10, children, ...props }: QueryFacetsProps) {
  const editor = useQueryContext()

  const values = useMemo(() => {
    const counts = editor.facets(field)

    const selected = new Set(
      editor.clauses.flatMap((clause) =>
        clause.field === field &&
        clause.occur !== 'must-not' &&
        (clause.value.kind === 'term' ||
          (clause.value.kind === 'phrase' && (clause.value.proximity ?? 0) === 0))
          ? [clause.value.raw]
          : [],
      ),
    )

    return [...counts]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, limit)
      .map(([value, count]) => ({ value, count, selected: selected.has(value) }))
  }, [editor, field, limit])

  if (values.length === 0) return null

  // Custom keyboard-managed facet list, not a native select.
  // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role
    <ul {...props} aria-label={props['aria-label'] ?? `${field} values`}>
      {children
        ? children(values)
        : values.map((entry) => (
            <li key={entry.value}>
              <button
                type="button"
                aria-pressed={entry.selected}
                data-selected={entry.selected ? '' : undefined}
                onClick={() => {
                  editor.applyText(toggleClause(editor.applied, { field, value: entry.value }))
                }}
              >
                {entry.value}
                <span>{entry.count}</span>
              </button>
            </li>
          ))}
    </ul>
  )
}

export const Query = {
  Root,
  Provider,
  Input,
  Suggestions,
  Option,
  Diagnostics,
  Submit,
  Clear,
  Highlight,
  Chips,
  Facets,
}
