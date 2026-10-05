# Effect core and backend adapters

[← README](../README.md#appendix) · [Quick start](../README.md#quick-start)

`react-lucene-query/core` imports no React. Pure language helpers stay pure; engine construction and query execution use typed Effect failures.

```ts
import { Effect } from 'effect'
import { QueryEngine } from 'react-lucene-query/core'

const makeEngine = QueryEngine.make({ fields })

const results = Effect.gen(function* () {
  const engine = yield* makeEngine
  return yield* engine.filter('status:ready AND units:[100 TO 200]', orders)
})

const rows = await Effect.runPromise(results)
```

| Core operation                          | Result                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| `QueryEngine.make(options)`             | `Effect<QueryEngine<T>, QueryConfigurationError>`                                    |
| `engine.parse(text)`                    | Pure `ParsedQuery`, including partial AST and diagnostics                            |
| `engine.compile(text)`                  | `Effect<CompiledQuery<T>, InvalidQueryError>`                                        |
| `engine.filter(text, records)`          | `Effect<readonly T[], InvalidQueryError>`                                            |
| `engine.suggest(text, caret, records?)` | `Option<SuggestionList>`                                                             |
| `engine.search(text, adapter)`          | Effect preserving the adapter's result, typed failures, and environment requirements |
| `engine.facets(text, records, opts?)`   | `Effect<FacetCounts, InvalidQueryError>`                                             |
| `engine.clauses(text)`                  | Pure `readonly Clause[]`                                                             |

Errors are tagged subclasses. Handle expected failures with `Effect.catchTag` or `Effect.result` / `Result.match`; defects such as throwing record accessors are not silently swallowed.

Advanced users can import `toQueryEngineAdapter` from `react-lucene-query/core` to reuse an existing Effect engine in React. Normal consumers use only `createQueryEngine` from the main entry. The React adapter catches **only** `InvalidQueryError` when deriving an inert predicate for invalid externally controlled applied state. `engine.facets` is the one deliberate exception on that plain facade: it throws the typed `InvalidQueryError`, because counting values through an inert "matches nothing" predicate would report every option as unavailable, which reads as a real result. React code does not take that path — `Query.Root` counts through the tolerant `compile`.

`InvalidQueryError` is declared with `Schema.TaggedError` rather than `Data.TaggedError`, because it is the one error a server sends back to a client: `Schema.encodeSync(InvalidQueryError)(error)` produces the wire shape and `Schema.decodeUnknownEffect(InvalidQueryError)(payload)` returns the error itself, so a server and its client cannot restate the same fields twice. `QueryConfigurationError` never crosses a wire and stays a plain `Data.TaggedError`.

`QueryEngine.make` and `engine.search` are traced, so a misconfigured schema and an adapter call show up in a span. `compile`, `filter` and `facets` are untraced-eager: they are pure CPU over caller data and run on every keystroke.

## Backend execution seam

`SearchAdapter<A, E, R>` is a function from validated `ParsedQuery` to `Effect<A, E, R>`. The adapter owns SQL/HTTP/search-index translation, authorization, encoding, and resources; the library does not invent a backend protocol or silently execute work inside React render.

```ts
import { Effect } from 'effect'
import { filterRecords, QueryEngine, type SearchAdapter } from 'react-lucene-query/core'

// This local adapter is runnable; substitute your own Effect-powered repository at this seam.
const searchOrders: SearchAdapter<readonly Order[]> = (parsed) =>
  Effect.sync(() => filterRecords(parsed.node, fields, orders))

const program = Effect.gen(function* () {
  const engine = yield* QueryEngine.make({ fields })
  return yield* engine.search('status:ready', searchOrders)
})
```

Connect `onApply` to your application's runtime or request-state layer for backend-only UI. Provide layers and cancellation at that boundary; this library does not run an asynchronous Effect with `runSync`.

Run the HTTP backend example:

```sh
bun run example:backend
```

`example/backend.ts` starts a loopback Bun HTTP server with synthetic shipment records.
It needs no credentials or additional dependencies.
The adapter sends query text only, not a serialized AST.
The server validates the request and compiles the query before filtering records.
The client validates successful responses and query rejection responses with Effect Schema.

The command checks filtering, invalid-query rejection at both boundaries, and typed transport failure after server shutdown.
HTTP status and response validation failures have separate typed errors.
The request format belongs to the example application.
The library does not define a backend execution protocol. Optional [query output modules](query-outputs.md) provide a versioned JSON representation and conservative PostgreSQL condition translation; adapters still own execution and authorization.

Pure exports also include `tokenize`, `tokenValue`, `parseQuery`, `hasErrors`, `compileQuery`, `tryCompileQuery`, `matchesQuery`, `filterRecords`, `facetCounts`, `listClauses`, `removeClause`, `toggleClause`, `escapeTerm`, `escapeFieldName`, `fieldClause`, `and`, `or`, `not`, `readPath`, `fieldValues`, `parseDate`, `parseNumber`, `getSuggestions`, and `applySuggestion`. Low-level AST evaluators assume already validated input; never execute a partial AST from an invalid query.

`getSuggestions` returns `Option<SuggestionList>`: "no completion here" is an answer, not a missing value. Use `Option.getOrUndefined` at a React boundary.

## Compiling a node you built yourself

`parseQuery` validates a node before `compileQuery` ever sees it, so parsed text cannot reach a compile failure. A hand-built AST can: a wildcard escape that never closes, a fuzzy distance above two, a proximity that is not an integer. Those failures are typed, not bare exceptions.

| Call              | Result                                                                  |
| ----------------- | ----------------------------------------------------------------------- |
| `compileQuery`    | `(record: T) => boolean`, throws `QueryValueError` / `RegexSyntaxError` |
| `tryCompileQuery` | `Result<(record: T) => boolean, QueryValueError \| RegexSyntaxError>`   |

`tryCompileQuery` is the seam to use when the AST is not the parser's: `Result.isFailure` gives you the reason instead of a `catch`. The engine uses it internally, so an invalid query becomes an `InvalidQueryError` diagnostic rather than escaping as an Effect defect.

Related: [Plain engine API](engine.md) · [Remote React search](react.md#remote-search)
