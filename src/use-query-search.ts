import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hasErrors, type ParsedQuery } from './core'
import type { QueryEngine } from './engine-adapter'

const EMPTY_RECORDS: readonly never[] = []

export interface QuerySearchCommonOptions {
  readonly value?: string
  readonly defaultValue?: string
  readonly appliedValue?: string
  readonly defaultAppliedValue?: string
  readonly onValueChange?: (value: string) => void
  /** Called only for valid submissions. Use this seam for server-side searching. */
  readonly onApply?: (value: string, parsed: ParsedQuery) => void
}

export interface LocalSearchOptions<T> extends QuerySearchCommonOptions {
  readonly mode?: 'local'
  readonly engine: QueryEngine<T>
  readonly records?: readonly T[]
}

export interface AsyncSearchOptions<T> extends QuerySearchCommonOptions {
  readonly mode: 'async'
  readonly engine: QueryEngine<T>
  /**
   * Runs one applied query. It must honor `signal` and reject with an `AbortError` when the request
   * is cancelled, so a slow response from a superseded query can never overwrite a newer one.
   */
  readonly search: (text: string, signal: AbortSignal) => Promise<readonly T[]>
  /** Delay before an applied query reaches `search`, so typing does not flood the backend. */
  readonly debounceMs?: number
}

export type UseQuerySearchOptions<T> = LocalSearchOptions<T> | AsyncSearchOptions<T>

export type QuerySearchStatus = 'ready' | 'loading' | 'error'

type RemoteState<T> = {
  readonly text: string
  readonly attempt: number
} & (
  | { readonly status: 'ready'; readonly results: readonly T[] }
  | { readonly status: 'error'; readonly error: SearchError }
)

/**
 * How a rejected search is reported. Both `fetch` and `Effect` failures carry a `name`, so a
 * cancelled request is recognized without inspecting the payload.
 */
export type SearchError = {
  readonly name: string
  readonly message?: string
}

function isAbort(error: SearchError): boolean {
  return error.name === 'AbortError'
}

/**
 * Draft/applied separation for either local filtering or a remote search. Async mode owns the
 * request lifecycle every consumer otherwise rewrites: debounce, cancellation, and stale-response
 * rejection. Only a valid query is ever applied, so an invalid draft never reaches `search`.
 */
export function useQuerySearch<T>(options: UseQuerySearchOptions<T>) {
  const {
    engine,
    value,
    defaultValue = '',
    appliedValue,
    defaultAppliedValue = '',
    onValueChange,
    onApply,
  } = options

  // Async mode owns no records: the results come from `search`, and records are not filterable
  // across a worker boundary anyway.
  const records = options.mode === 'async' ? EMPTY_RECORDS : (options.records ?? EMPTY_RECORDS)
  const search = options.mode === 'async' ? options.search : undefined
  const debounceMs = options.mode === 'async' ? (options.debounceMs ?? 0) : 0
  const async = options.mode === 'async'

  const [internalDraft, setInternalDraft] = useState(defaultValue)
  const [internalApplied, setInternalApplied] = useState(defaultAppliedValue)
  const [remote, setRemote] = useState<RemoteState<T> | undefined>()
  const [attempts, setAttempts] = useState(0)

  const draft = value ?? internalDraft
  const applied = appliedValue ?? internalApplied
  const parsedDraft = useMemo(() => engine.parse(draft), [engine, draft])
  const compiled = useMemo(() => engine.compile(applied), [engine, applied])
  const localResults = useMemo(() => records.filter(compiled.test), [records, compiled])

  const invalidApplied = hasErrors(compiled.parsed)

  // Update the callback after commit, before dispatching requests. Its identity is not a query
  // dependency: inline callbacks must not re-fetch whenever an answer causes a render.
  const searchRef = useRef(search)

  useEffect(() => {
    searchRef.current = search
  }, [search])

  // The latest request owns the results; an older one that resolves late is discarded.
  const requestRef = useRef(0)

  useEffect(() => {
    if (!async || invalidApplied) return

    const controller = new AbortController()
    const request = requestRef.current + 1

    requestRef.current = request

    const run = () => {
      const callback = searchRef.current

      if (!callback) return

      Promise.resolve()
        .then(() =>
          controller.signal.aborted ? EMPTY_RECORDS : callback(applied, controller.signal),
        )
        .then(
          (results) => {
            if (requestRef.current !== request || controller.signal.aborted) return
            setRemote({ text: applied, attempt: attempts, status: 'ready', results })
          },
          (error: SearchError) => {
            if (requestRef.current !== request || controller.signal.aborted || isAbort(error)) {
              return
            }

            setRemote({ text: applied, attempt: attempts, status: 'error', error })
          },
        )
    }

    const timer = debounceMs > 0 ? setTimeout(run, debounceMs) : undefined

    if (timer === undefined) run()

    return () => {
      if (timer !== undefined) clearTimeout(timer)
      controller.abort()
    }
  }, [applied, attempts, async, debounceMs, invalidApplied])

  const setDraft = useCallback(
    (next: string) => {
      if (value === undefined) setInternalDraft(next)
      onValueChange?.(next)
    },
    [value, onValueChange],
  )

  const submit = useCallback(
    (next = draft): boolean => {
      const parsed = engine.compile(next).parsed

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

  // Answers belong to one attempt as well as one query: refresh starts a new loading state,
  // and a successful retry replaces (rather than coexisting with) the previous failure.
  const settled =
    async &&
    !invalidApplied &&
    remote !== undefined &&
    remote.text === applied &&
    remote.attempt === attempts

  const results = invalidApplied
    ? []
    : async
      ? settled && remote.status === 'ready'
        ? remote.results
        : []
      : localResults

  const status: QuerySearchStatus =
    !async || invalidApplied ? 'ready' : settled ? remote.status : 'loading'

  const loading = status === 'loading'

  return {
    mode: async ? ('async' as const) : ('local' as const),
    draft,
    applied,
    parsedDraft,
    parsedApplied: compiled.parsed,
    results,
    /** Alias of `results`, kept because local filtering reads better under the old name. */
    matches: results,
    status,
    error: settled && remote.status === 'error' ? remote.error : undefined,
    isValid: !hasErrors(parsedDraft),
    isPending: draft.trim() !== applied.trim() || loading,
    isLoading: loading,
    refresh: () => setAttempts((count) => count + 1),
    setDraft,
    submit,
    apply,
    clear: () => apply(''),
    invalidApplied,
  }
}

export type QuerySearchState<T> = ReturnType<typeof useQuerySearch<T>>
