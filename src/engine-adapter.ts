import { Effect, Option } from 'effect'
import type { Clause } from './core/clauses'
import type { FacetCounts, FacetOptions } from './core/facets'
import {
  QueryEngine as EffectQueryEngine,
  type CompiledQuery,
  type QueryEngineOptions,
} from './core/engine'
import type { QueryField } from './core/fields'
import type { ParsedQuery } from './core/types'
import type { SuggestionList } from './core/suggest'

export interface QueryEngine<T> {
  readonly fields: readonly QueryField<T>[]
  readonly parse: (text: string) => ParsedQuery
  readonly compile: (text: string) => CompiledQuery<T>
  readonly filter: (text: string, records: readonly T[]) => readonly T[]
  readonly suggest: (
    text: string,
    caret: number,
    records?: readonly T[],
  ) => SuggestionList | undefined
  readonly facets: (text: string, records: readonly T[], options?: FacetOptions) => FacetCounts
  readonly clauses: (text: string) => readonly Clause[]
}

/** Synchronous React boundary; only expected validation failures become inert draft predicates. */
export function toQueryEngineAdapter<T>(engine: EffectQueryEngine<T>): QueryEngine<T> {
  const compile = (text: string) =>
    Effect.runSync(
      engine.compile(text).pipe(
        Effect.catchTag('InvalidQueryError', (error) =>
          Effect.succeed({
            parsed: { ...engine.parse(text), diagnostics: error.diagnostics },
            test: (_record: T) => false,
          }),
        ),
      ),
    )

  return {
    fields: engine.fields,
    parse: engine.parse,
    compile,
    filter: (text, records) => records.filter(compile(text).test),
    suggest: (text, caret, records) => Option.getOrUndefined(engine.suggest(text, caret, records)),
    // The one deliberate exception to this boundary's tolerance: counting values through an inert
    // "matches nothing" predicate would report every value as unavailable, which reads as a real
    // result. So an invalid query throws the typed `InvalidQueryError` here. React code does not hit
    // this path — `Query.Root` counts through the tolerant `compile` — it is for direct callers.
    facets: (text, records, options) => Effect.runSync(engine.facets(text, records, options)),
    clauses: (text) => engine.clauses(text),
  }
}

/** Convenience at a React composition root. Invalid configuration throws; Effect users use QueryEngine.make. */
export function createQueryEngine<T>(options: QueryEngineOptions<T>): QueryEngine<T> {
  return toQueryEngineAdapter(Effect.runSync(Effect.orDie(EffectQueryEngine.make(options))))
}
