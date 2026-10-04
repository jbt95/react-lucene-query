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
import type { ParsedQuery, Suggestion, SuggestionList } from './core'
import type { QueryEngine } from './query-engine-adapter'
import { QueryContext, useQueryContext, type QueryContextValue } from './query-context'
import { useQueryEditor } from './use-query-editor'

const EMPTY_RECORDS: readonly never[] = []

export interface QueryRootProps<T> {
  readonly engine: QueryEngine<T>
  readonly records?: readonly T[]
  readonly value: string
  readonly parsed?: ParsedQuery
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

  const editor = useQueryEditor({
    value,
    parsed: parsedValue,
    onValueChange,
    onSubmit,
    getSuggestions: getSuggestions ?? suggest,
  })

  return (
    <QueryContext.Provider value={{ ...editor, parse: engine.parse }}>
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
}
