import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  applySuggestion,
  hasErrors,
  type ParsedQuery,
  type Suggestion,
  type SuggestionList,
} from './core'

export interface UseQueryEditorOptions {
  readonly value: string
  readonly parsed: ParsedQuery
  readonly onValueChange: (value: string) => void
  readonly onSubmit: (value: string) => boolean
  readonly getSuggestions: (value: string, caret: number) => SuggestionList | undefined
}

/** Wraps in both directions; an empty selection moves to the last item going up. */
function nextHighlightIndex(activeIndex: number, length: number, down: boolean): number {
  return down ? (activeIndex + 1) % length : (activeIndex <= 0 ? length : activeIndex) - 1
}

export function useQueryEditor({
  value,
  parsed,
  onValueChange,
  onSubmit,
  getSuggestions,
}: UseQueryEditorOptions) {
  const id = useId()
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const setInputRef = useCallback((node: HTMLTextAreaElement | null) => {
    inputRef.current = node
  }, [])

  const pendingCaret = useRef<number>()
  const [caret, setCaret] = useState(value.length)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState<string>()
  const [highlight, setHighlight] = useState<{ key: string; index: number }>()
  const [rejectedValue, setRejectedValue] = useState<string>()
  const key = `${value}\u0000${caret}`

  const suggestions = useMemo(
    () => (focused ? getSuggestions(value, caret) : undefined),
    [focused, getSuggestions, value, caret],
  )

  const open = Boolean(suggestions?.items.length) && dismissed !== key

  const activeIndex = Math.min(
    highlight?.key === key ? highlight.index : suggestions?.autoSelect ? 0 : -1,
    (suggestions?.items.length ?? 0) - 1,
  )

  const hasError = hasErrors(parsed)

  // The caret must move after React commits the new text, so a handler records the
  // request and this effect applies it. Callers only record a request when the text
  // or caret really changes, so a request can never outlive the update that justified it.
  useEffect(() => {
    const requested = pendingCaret.current

    if (requested === undefined) return

    pendingCaret.current = undefined
    inputRef.current?.setSelectionRange(requested, requested)
  }, [value, caret])

  const accept = (item: Suggestion) => {
    if (!suggestions) return
    const next = applySuggestion(value, suggestions, item)
    inputRef.current?.focus()
    pendingCaret.current = next.value !== value || next.caret !== caret ? next.caret : undefined
    onValueChange(next.value)
    setCaret(next.caret)
    setHighlight(undefined)
    setDismissed(
      item.kind === 'value' && !item.keepOpen ? `${next.value}\u0000${next.caret}` : undefined,
    )
  }

  const submit = () => {
    setDismissed(key)
    const applied = onSubmit(value)
    setRejectedValue(applied ? undefined : value)

    return applied
  }

  const clear = () => {
    inputRef.current?.focus()
    onValueChange('')
    onSubmit('')
    pendingCaret.current = value !== '' || caret !== 0 ? 0 : undefined
    setCaret(0)
    setRejectedValue(undefined)
    setDismissed(undefined)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return

    if ((event.ctrlKey || event.metaKey) && event.key === ' ') {
      event.preventDefault()
      setDismissed(undefined)

      return
    }

    const items = suggestions?.items ?? []

    if (open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlight({
          key,
          index: nextHighlightIndex(activeIndex, items.length, event.key === 'ArrowDown'),
        })

        return
      }

      const item = items[event.key === 'Tab' && activeIndex < 0 ? 0 : activeIndex]

      if (item && ((event.key === 'Tab' && !event.shiftKey) || event.key === 'Enter')) {
        event.preventDefault()
        accept(item)

        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissed(key)

        return
      }
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    }
  }

  return {
    value,
    parsed,
    caret,
    focused,
    open,
    suggestions,
    activeIndex,
    hasError,
    rejected: rejectedValue === value,
    inputRef,
    setInputRef,
    inputId: `${id}-input`,
    listId: `${id}-list`,
    diagnosticsId: `${id}-diagnostics`,
    optionId: (index: number) => `${id}-option-${index}`,
    getSuggestions,
    onSubmit,
    onValueChange,
    setCaret,
    setFocused,
    onKeyDown,
    accept,
    submit,
    clear,
    highlight: (index: number) => setHighlight({ key, index }),
    dismiss: () => setDismissed(key),
  }
}

export type QueryEditorState = ReturnType<typeof useQueryEditor>
