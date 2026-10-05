import { useCallback, useEffect, useState } from 'react'

/** The part of `window.location` this hook reads and rewrites. */
export type QueryUrlTarget = {
  readonly search: string
  readonly pathname: string
  readonly hash?: string
}

export type QueryUrlHistory = {
  /** Existing router/navigation metadata, preserved by query-only updates. */
  readonly state?: History['state']
  pushState: (data: History['state'], unused: string, url: string) => void
  replaceState: (data: History['state'], unused: string, url: string) => void
}

export interface UseQueryUrlStateOptions {
  /** Query parameter name. Defaults to `q`. */
  readonly key?: string
  /** Overwrite the current history entry instead of adding one. */
  readonly replace?: boolean
  /** Value used before a location exists, which is always the case on a server. */
  readonly initial?: string
  /** Override the location, which is what a test or an embedded shell provides. */
  readonly target?: QueryUrlTarget
  /** Override the history, which decides push versus replace. */
  readonly history?: QueryUrlHistory
}

function browserTarget(): QueryUrlTarget | undefined {
  if (typeof window === 'undefined') return undefined

  return window.location
}

function browserHistory(): QueryUrlHistory | undefined {
  return typeof window === 'undefined' ? undefined : window.history
}

function readParam(params: URLSearchParams, key: string): string {
  return params.get(key) ?? ''
}

/**
 * Keeps one query in the URL, so a search survives a reload, a shared link, and browser history.
 * `popstate` keeps Back and Forward in step with the editor, and the setter works without one.
 */
export function useQueryUrlState({
  key = 'q',
  replace = false,
  initial = '',
  target,
  history,
}: UseQueryUrlStateOptions = {}): readonly [string, (value: string) => void] {
  const [value, setValue] = useState(() =>
    (target ?? browserTarget()) === undefined
      ? initial
      : readParam(new URLSearchParams(target?.search ?? browserTarget()?.search ?? ''), key),
  )

  const read = useCallback(
    (source?: QueryUrlTarget) => {
      const location = source ?? target ?? browserTarget()

      if (location === undefined) return initial

      return readParam(new URLSearchParams(location.search), key)
    },
    [initial, key, target],
  )

  useEffect(() => {
    if (typeof window === 'undefined') return

    const onPopState = () => {
      setValue(read())
    }

    window.addEventListener('popstate', onPopState)

    return () => window.removeEventListener('popstate', onPopState)
  }, [read])

  const setUrlValue = useCallback(
    (next: string) => {
      const location = target ?? browserTarget()
      const navigator = history ?? browserHistory()

      if (location === undefined || navigator === undefined) return

      const params = new URLSearchParams(location.search)

      if (next === '') params.delete(key)
      else params.set(key, next)

      const search = params.toString()
      const url = `${location.pathname}${search === '' ? '' : `?${search}`}${location.hash ?? ''}`

      if (replace) navigator.replaceState(navigator.state ?? null, '', url)
      else navigator.pushState(navigator.state ?? null, '', url)
      setValue(next)
    },
    [history, key, replace, target],
  )

  return [value, setUrlValue] as const
}
