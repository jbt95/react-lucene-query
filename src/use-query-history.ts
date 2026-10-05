import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Schema } from 'effect'
import { hasErrors } from './core'
import type { QueryEngine } from './engine-adapter'

export type QueryHistoryEntry = {
  readonly text: string
  readonly at: number
}

export type QueryHistoryState = {
  readonly entries: readonly QueryHistoryEntry[]
  readonly push: (text: string) => void
  readonly remove: (index: number) => void
  readonly clear: () => void
}

export type UseQueryHistoryOptions<T> = {
  /** The engine, so only valid applied queries are remembered. */
  readonly engine: QueryEngine<T>
  /** Storage key. Defaults to `react-lucene-query:history`. */
  readonly key?: string
  /** Newest first, capped. Defaults to 20. */
  readonly limit?: number
  /** The applied query; a new valid value is pushed automatically. */
  readonly value?: string
  /** Pass `null` to keep history in memory only, which is what a server render wants. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
}

const HistoryEntries = Schema.Array(Schema.Struct({ text: Schema.String, at: Schema.Number }))

function readEntries(
  storage: UseQueryHistoryOptions<never>['storage'],
  key: string,
): readonly QueryHistoryEntry[] {
  if (!storage) return []

  try {
    const raw = storage.getItem(key)

    if (!raw) return []

    // Persisted history is untrusted input: it is decoded, not trusted, and unreadable data is
    // simply an empty history rather than a broken search.
    const decoded = Schema.decodeUnknownSync(HistoryEntries)(JSON.parse(raw))

    return decoded.slice(0, 50)
  } catch {
    return []
  }
}

function defaultStorage(): UseQueryHistoryOptions<never>['storage'] {
  if (typeof window === 'undefined') return null

  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * Remembers applied queries, newest first, and persists them. Every search application of a new
 * valid query is recorded, so this doubles as recent searches for a suggestion dropdown.
 */
export function useQueryHistory<T>({
  engine,
  key = 'react-lucene-query:history',
  limit = 20,
  value,
  storage,
}: UseQueryHistoryOptions<T>): QueryHistoryState {
  const resolved = useMemo(() => {
    if (storage === undefined) return defaultStorage()

    return storage
  }, [storage])

  const [snapshot, setSnapshot] = useState(() => ({
    key,
    storage: resolved,
    entries: readEntries(resolved, key),
  }))

  // Reset the namespace before exposing callbacks or recording an applied value. An effect-only
  // reset would let the old entries be written to the new key during that same commit.
  if (snapshot.key !== key || snapshot.storage !== resolved) {
    setSnapshot({ key, storage: resolved, entries: readEntries(resolved, key) })
  }

  useEffect(() => {
    if (!snapshot.storage) return

    try {
      snapshot.storage.setItem(snapshot.key, JSON.stringify(snapshot.entries))
    } catch {
      // A full or blocked quota costs history, not the search.
    }
  }, [snapshot])

  const write = useCallback(
    (update: (entries: readonly QueryHistoryEntry[]) => readonly QueryHistoryEntry[]) => {
      setSnapshot((current) => ({ ...current, entries: update(current.entries) }))
    },
    [],
  )

  const push = useCallback(
    (text: string) => {
      if (text.trim() === '' || hasErrors(engine.parse(text))) return
      // Re-applying the same query must not fill the list with duplicates.
      const at = Date.now()

      write((entries) =>
        [{ text, at }, ...entries.filter((entry) => entry.text !== text)].slice(0, limit),
      )
    },
    [engine, limit, write],
  )

  const remove = useCallback(
    (index: number) => {
      write((entries) => entries.filter((_, position) => position !== index))
    },
    [write],
  )

  const clear = useCallback(() => {
    write(() => [])
  }, [write])

  const lastRecorded = useRef<
    | {
        readonly key: string
        readonly storage: typeof resolved
        readonly value: string
      }
    | undefined
  >(undefined)

  useEffect(() => {
    if (value === undefined) return

    const previous = lastRecorded.current

    if (previous?.key === key && previous.storage === resolved && previous.value === value) return
    lastRecorded.current = { key, storage: resolved, value }
    push(value)
  }, [key, push, resolved, value])

  return { entries: snapshot.entries, push, remove, clear }
}
