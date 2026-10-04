import { useCallback, useMemo, useState } from 'react'
import { hasErrors, type ParsedQuery } from './core'
import type { QueryEngine } from './query-engine-adapter'

const EMPTY_RECORDS: readonly never[] = []

export interface UseQuerySearchOptions<T> {
  readonly engine: QueryEngine<T>
  readonly records?: readonly T[]
  readonly value?: string
  readonly defaultValue?: string
  readonly appliedValue?: string
  readonly defaultAppliedValue?: string
  readonly onValueChange?: (value: string) => void
  /** Called only for valid submissions. Use this seam for server-side searching. */
  readonly onApply?: (value: string, parsed: ParsedQuery) => void
}

export function useQuerySearch<T>({
  engine,
  records = EMPTY_RECORDS,
  value,
  defaultValue = '',
  appliedValue,
  defaultAppliedValue = '',
  onValueChange,
  onApply,
}: UseQuerySearchOptions<T>) {
  const [internalDraft, setInternalDraft] = useState(defaultValue)
  const [internalApplied, setInternalApplied] = useState(defaultAppliedValue)
  const draft = value ?? internalDraft
  const applied = appliedValue ?? internalApplied
  const parsedDraft = useMemo(() => engine.parse(draft), [engine, draft])
  const compiled = useMemo(() => engine.compile(applied), [engine, applied])
  const matches = useMemo(() => records.filter(compiled.test), [records, compiled])

  const setDraft = useCallback(
    (next: string) => {
      if (value === undefined) setInternalDraft(next)
      onValueChange?.(next)
    },
    [value, onValueChange],
  )

  const submit = useCallback(
    (next = draft): boolean => {
      const parsed = engine.parse(next)

      if (hasErrors(parsed)) return false

      if (appliedValue === undefined) setInternalApplied(next)
      onApply?.(next, parsed)

      return true
    },
    [draft, engine, appliedValue, onApply],
  )

  const apply = useCallback(
    (next: string): boolean => {
      setDraft(next)

      return submit(next)
    },
    [setDraft, submit],
  )

  return {
    draft,
    applied,
    parsedDraft,
    parsedApplied: compiled.parsed,
    matches,
    isPending: draft.trim() !== applied.trim(),
    isValid: !hasErrors(parsedDraft),
    setDraft,
    submit,
    apply,
    clear: () => apply(''),
  }
}

export type QuerySearchState<T> = ReturnType<typeof useQuerySearch<T>>
