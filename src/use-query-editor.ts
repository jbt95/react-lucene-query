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

  useEffect(() => {
    if (pendingCaret.current !== undefined && inputRef.current) {
      inputRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current)
      pendingCaret.current = undefined
    }
  }, [value, caret])

  const accept = (item: Suggestion) => {
    if (!suggestions) return
    const next = applySuggestion(value, suggestions, item)
    inputRef.current?.focus()
    pendingCaret.current = next.caret
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
    pendingCaret.current = 0
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

        const index =
          event.key === 'ArrowDown'
            ? (activeIndex + 1) % items.length
            : (activeIndex <= 0 ? items.length : activeIndex) - 1

        setHighlight({ key, index })

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
