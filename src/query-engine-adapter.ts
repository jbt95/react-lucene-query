import { Effect, Option, Result } from 'effect'
import {
  QueryEngine as EffectQueryEngine,
  type CompiledQuery,
  type QueryEngineOptions,
} from './core/query-engine'
import type { QueryField } from './core/query-fields'
import type { ParsedQuery } from './core/query-types'
import type { SuggestionList } from './core/query-suggest'

export interface QueryEngine<T> {
  readonly fields: readonly QueryField<T>[]
  readonly today: string
  readonly parse: (text: string) => ParsedQuery
  readonly compile: (text: string) => CompiledQuery<T>
  readonly filter: (text: string, records: readonly T[]) => readonly T[]
  readonly suggest: (
    text: string,
    caret: number,
    records?: readonly T[],
  ) => SuggestionList | undefined
}

/** Synchronous React boundary; only expected validation failures become inert draft predicates. */
export function toQueryEngineAdapter<T>(engine: EffectQueryEngine<T>): QueryEngine<T> {
  const compile = (text: string) =>
    Effect.runSync(
      engine
        .compile(text)
        .pipe(
          Effect.catchTag('InvalidQueryError', () =>
            Effect.succeed({ parsed: engine.parse(text), test: (_record: T) => false }),
          ),
        ),
    )

  return {
    fields: engine.fields,
    today: engine.today,
    parse: engine.parse,
    compile,
    filter: (text, records) => records.filter(compile(text).test),
    suggest: (text, caret, records) => Option.getOrUndefined(engine.suggest(text, caret, records)),
  }
}

/** Convenience at a React composition root. Invalid configuration throws; Effect users use QueryEngine.make. */
export function createQueryEngine<T>(options: QueryEngineOptions<T>): QueryEngine<T> {
  const result = Effect.runSync(Effect.result(EffectQueryEngine.make(options)))

  return Result.match(result, {
    onSuccess: toQueryEngineAdapter,
    onFailure: (error) => {
      throw error
    },
  })
}
