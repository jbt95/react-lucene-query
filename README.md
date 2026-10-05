# react-lucene-query

Schema-driven [Lucene query](https://lucene.apache.org/core/9_1_0/queryparser/org/apache/lucene/queryparser/classic/package-summary.html) search with an **Effect core** and **composable React primitives**.

Define searchable fields once. The same definitions drive parsing, diagnostics, syntax roles, suggestions, and local matching. Keep the headless primitives, use the optional Tailwind field, bring CodeMirror, or move filtering to a worker.

Fields can hold several values, and can be typed as `text`, `keyword`, `number`, or `date`, with an optional per-field analyzer. On top of the editor there is query building that escapes user input, click-to-query chips, facet counts, remote search with cancellation, shareable URLs, recent searches, and an off-main-thread worker.

> This implements the classic Lucene query language with local filtering. It does not run an Apache Lucene index, and it does not reproduce Lucene analyzers or scoring. This repository is the initial library extraction; it has not been published to npm.

## Run the playground

Requires Bun 1.4.2 or newer. Typechecking and declaration generation use **TypeScript 7.0.2's native Go compiler**.

```sh
git clone https://github.com/jbt95/react-lucene-query.git
cd react-lucene-query
bun install
bun run dev
```

The playground demonstrates styled, headless, and lazily loaded CodeMirror presentations against the same query state, using synthetic shipment records.

To use the library in another local project:

```sh
bun run check
bun pm pack
# In your application:
bun add /absolute/path/to/react-lucene-query/react-lucene-query-0.1.0.tgz
```

React 18.3 or 19 is a peer dependency. Effect 4 is the only runtime dependency. Consumers do not need TypeScript 7 at runtime, though declaration compatibility is currently verified with TypeScript 7.

## Quick start

```tsx
import { createQueryEngine, useQuerySearch, type QueryField } from 'react-lucene-query'
import { QuerySearchField } from 'react-lucene-query/styled'
import 'react-lucene-query/styles.css'

interface Order {
  id: string
  status: string
  notes: string
}

const fields: readonly QueryField<Order>[] = [
  { key: 'id', label: 'Order', type: 'keyword', read: (row) => row.id, freeText: true },
  {
    key: 'status',
    label: 'Status',
    type: 'keyword',
    options: ['ready', 'delayed'],
    read: (row) => row.status,
  },
  { key: 'notes', label: 'Notes', type: 'text', read: (row) => row.notes, freeText: true },
]

// Keep the engine identity stable: construct outside render, or useMemo for dynamic schemas.
const engine = createQueryEngine({ fields })

export function OrderSearch({ orders }: { orders: readonly Order[] }) {
  const search = useQuerySearch({ engine, records: orders })

  return (
    <>
      <QuerySearchField
        engine={engine}
        records={orders}
        label="Search orders"
        value={search.draft}
        parsed={search.parsedDraft}
        onValueChange={search.setDraft}
        onSubmit={search.submit}
        summary={`${search.matches.length} matching orders`}
      />
      <ul>
        {search.matches.map((order) => (
          <li key={order.id}>{order.id}</li>
        ))}
      </ul>
    </>
  )
}
```

Typing changes the **draft**. Enter/Search applies a valid query. Invalid drafts never replace the applied query. Clear applies the empty query, which matches all records.

### Field definitions

`QueryField<T>` has `key`, `label`, `type`, and **exactly one** accessor: `read(record)` or `path`. Types are `text`, `keyword`, `number`, and `date`.

- Mark fields `freeText: true` to include them in unqualified searches.
- `text` fields are analyzed into lowercase Unicode letter/digit tokens. `keyword` fields keep the whole scalar value and compare it case-sensitively.
- `number` fields compare numerically, so `units:120` and `units:[100 TO 200]` both work; `units:1,200` and `units:many` are legal queries that match nothing. A bound that is not a number rejects the clause rather than being skipped.
- `date` fields compare instants. `2026`, `2026-10`, `2026-10-24`, and `2026-10-24T09:30Z` are all dates, and a partially written one covers its whole window, so `due:2026-10` matches every day in October. An inclusive range bound covers its whole window and an exclusive one skips it entirely, so `due:{2026-10-01 TO 2026-10-24}` excludes both the 1st and the 24th. Impossible dates such as `2026-02-30` match nothing. Text that cannot read as a calendar date is epoch milliseconds.
- Wildcards, fuzzy terms, and regular expressions are not defined over `number` or `date`; those queries match nothing instead of guessing.
- `options` list literal values for suggestions. They never restrict what a query may search.
- Field lookup is case-sensitive. Keys must be nonempty, unique, and expressible as escaped field names.
- Accessors return a string, number, boolean, null, undefined, or **an array of those**. A multi-valued field indexes, matches, suggests, and counts every entry, so `tags:design` finds a record whose `tags` are `['design', 'urgent']`. Blank and missing values are unindexed, exactly like Lucene, so no pattern reaches them.
- Provide `path` instead of `read` for a plain property path such as `meta.owner.name` or `tags`. Paths survive structured cloning, which is what the worker entry requires; `__proto__`, `prototype`, and `constructor` are never traversed. Supplying neither accessor, or both, is a `QueryConfigurationError`.
- Add `analyze(value) => tokens` to a `text` field to replace the default tokenizer for both stored values and written terms. That is where stemming, diacritic folding, unit normalization, or CJK segmentation belongs.
- Treat schemas, records, and records arrays as immutable. Replace the records array when values change.

```ts
const fields: readonly QueryField<Order>[] = [
  { key: 'id', label: 'Order', type: 'keyword', read: (order) => order.id, freeText: true },
  { key: 'tags', label: 'Tags', type: 'keyword', read: (order) => order.tags },
  { key: 'units', label: 'Units', type: 'number', read: (order) => order.units },
  { key: 'due', label: 'Due', type: 'date', read: (order) => order.due, options: [] },
  {
    key: 'notes',
    label: 'Notes',
    type: 'text',
    freeText: true,
    read: (order) => order.notes,
    // `running` and `run` index the same token, and `1,000` matches `1000`.
    analyze: (value) => stem(value.toLowerCase().replaceAll(',', '')),
  },
]
```

## Building queries safely

Never interpolate a user-supplied value into query text. The builder escapes both sides of every condition, so a filter, a URL parameter, or a saved search cannot widen the query it is meant to narrow.

```ts
import { and, escapeTerm, fieldClause, not, or, toggleClause } from 'react-lucene-query'

const ready = fieldClause({ field: 'status', value: 'ready' }) // status:ready
const quoted = fieldClause({ field: 'carrier', value: 'North Star' }) // carrier:"North Star"
const safe = fieldClause({ field: 'q', value: '*:*' }) // q:"*:*", never a match-everything query

const query = and(ready, not(fieldClause({ field: 'status', value: 'delayed' })))
const either = or(fieldClause({ field: 'status', value: 'ready' }), escapeTerm('a AND b'))

toggleClause(query, { field: 'carrier', value: 'North Star' }) // adds it, or removes it if present
```

`and` and `or` parenthesize two or more clauses so the result can be nested without changing meaning, which is what makes `not(or(a, b))` a single prohibited condition. `toggleClause` never rewrites a query the parser rejects, and it treats `status:ready` and `status:"ready"` as the same condition. Its output is canonical text, which keeps Lucene's `+` prefix and re-quotes range bounds; that is stable under a further round trip.

## Click-to-query and facets

Nobody types `status:ready`; they click it. The engine counts the values each field holds among the records a query already selects, so an option that would return nothing is not offered.

```tsx
<Query.Root {...root} applied={search.applied}>
  <Query.Input />
  <Query.Chips /> {/* the applied conditions, each one removable */}
  <Query.Facets field="status" limit={8} />
</Query.Root>
```

| Primitive      | Contract                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------- |
| `Query.Chips`  | One removable button per applied condition; a free-text term is shown but not removable. |
| `Query.Facets` | Value buttons with counts for one field; `aria-pressed` marks a selected value.          |

Both default to plain `ul`/`button` markup and take a render-function child. `Query.Root` takes `applied` when the results describe something other than the draft; it defaults to the draft. The controller exposes `clauses`, `fields`, `facets(field)`, and `applyText(text)` for a fully custom presentation, and `engine.clauses(text)` / `engine.facets(text, records, options)` outside React.

## Headless composition

No CSS, icons, Tailwind, or CodeMirror are imported by the main entry.

```tsx
import { Query } from 'react-lucene-query'

;<Query.Root
  engine={engine}
  records={orders}
  value={search.draft}
  parsed={search.parsedDraft}
  onValueChange={search.setDraft}
  onSubmit={search.submit}
>
  <label htmlFor="order-query">Query</label>
  <Query.Input id="order-query" className="your-input" />
  <Query.Suggestions className="your-popup">
    {(items) =>
      items.map((item, index) => (
        <Query.Option key={item.id} item={item} index={index}>
          <span>{item.label}</span>
          <small>{item.detail}</small>
        </Query.Option>
      ))
    }
  </Query.Suggestions>
  <Query.Diagnostics />
  <Query.Submit>Apply</Query.Submit>
  <Query.Clear>Reset</Query.Clear>
</Query.Root>
```

| Primitive                      | Contract                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `Query.Root`                   | Controlled editor value; engine, optional records/parsed draft, change and boolean-returning submit callbacks.   |
| `Query.Input`                  | Textarea combobox with caret-aware keyboard behavior, refs, consumer event handlers, and diagnostic ARIA wiring. |
| `Query.Suggestions`            | Conditional listbox; default options or a render-function child.                                                 |
| `Query.Option`                 | Supply the suggestion and zero-based index; handles selection and pointer acceptance without stealing focus.     |
| `Query.Diagnostics`            | Polite live region containing parser diagnostics, including while typing.                                        |
| `Query.Submit` / `Query.Clear` | Buttons with preventable consumer click handlers.                                                                |
| `Query.Highlight`              | Non-interactive syntax spans with `data-role`; optional placeholder.                                             |
| `Query.Chips`                  | The applied conditions as removable buttons.                                                                     |
| `Query.Facets`                 | Value counts for one field among the current results, as toggling buttons.                                       |
| `Query.Provider`               | Supply a `QueryContextValue` from your own controller.                                                           |

`useQueryContext()` exposes editor state for your own presentation. `useQueryEditor()` lets you supply parsing and suggestion results yourself. Do not change glyph metrics between an input and its mirrored highlight.

Keyboard behavior: Arrow keys navigate open suggestions, Tab accepts, Enter accepts a selected completion or submits, Escape dismisses, and Ctrl/Cmd+Space reopens. Shift+Tab keeps normal backward focus navigation; IME composition is not submitted.

A visible label is required for accessibility. Headless consumers must label `Query.Input` and render `Query.Diagnostics` (or provide their own region with the controller's diagnostic ID).

### State control

`useQuerySearch` accepts controlled `value` / `appliedValue` independently, or uncontrolled `defaultValue` / `defaultAppliedValue`.

- `onValueChange(value)` receives draft changes.
- `onApply(value, parsed)` runs only on valid submissions.
- `setDraft` edits only the draft; `submit` applies; `apply` edits and submits; `clear` applies an empty query.
- `parsedDraft`, `parsedApplied`, `results`, `isValid`, and `isPending` are derived. `matches` is an alias of `results`.
- Records are optional for backend-only search. Invalid externally controlled applied values produce no results.
- Do not switch between controlled and uncontrolled ownership during the component lifetime.

### Remote search

`mode: 'async'` owns the request lifecycle every application otherwise rewrites: debounce, cancellation, and stale-response rejection.

```tsx
const search = useQuerySearch({
  mode: 'async',
  engine,
  search: (text, signal) =>
    fetch(`/api/shipments?q=${encodeURIComponent(text)}`, { signal }).then((response) =>
      response.json(),
    ),
  debounceMs: 200,
})

search.status // 'ready' | 'loading' | 'error', derived from which query the last answer belongs to
search.error // the failure of the current query only, never a superseded one
search.refresh() // re-run the applied query
```

`search` receives an `AbortSignal` that fires when the query changes or the component unmounts, and should reject with an error named `AbortError` when it honours that signal. A request that resolves late is discarded rather than allowed to overwrite newer results, and an invalid draft is never sent. `status` and `results` are derived from the query each answer belongs to, so a superseded failure can never be reported against the current query.

### Shareable links and recent searches

```tsx
const [fromUrl, setUrl] = useQueryUrlState({ key: 'q' })
const { entries, push, remove, clear } = useQueryHistory({ engine, value: search.applied })
```

`useQueryUrlState` keeps one query in the URL so a search survives a reload and travels in a shared link; it follows Back and Forward through `popstate`, and accepts `target` / `history` overrides. `useQueryHistory` records each applied query once, newest first, decodes what it reads rather than trusting storage, and accepts a `storage` override or `null` to stay in memory.

### Optional styling

Import `react-lucene-query/styles.css` once when using `QuerySearchField`. It is compiled Tailwind v4 CSS, so your application does not need a Tailwind build. Utilities use the `rlq:` prefix; there is no global Preflight reset.

Use `className` for layout and override scoped CSS variables such as `--rlq-accent`, `--rlq-surface`, `--rlq-text`, `--rlq-border`, and `--rlq-error`. `label`, `placeholder`, `disabled`, and `summary` customize the ready-made field. Suggestions stay in document flow rather than requiring a portal.

## Plain engine API

Normal React consumers never need to import Effect or run a runtime:

```ts
import { createQueryEngine } from 'react-lucene-query'

const engine = createQueryEngine({ fields, unknownFields: 'suggest' })
const parsed = engine.parse('status:ready')
const rows = engine.filter('status:ready', orders)
const suggestions = engine.suggest('sta', 3, orders)
const chips = engine.clauses('status:ready AND carrier:arc')
const counts = engine.facets('status:ready', orders)
```

The main entry's `QueryEngine<T>` type describes this plain facade. Its methods return ordinary values. Invalid queries retain diagnostics and produce inert predicates / no matches; invalid configuration throws `QueryConfigurationError`, not an Effect runtime wrapper.

An unknown field is legal Lucene and matches nothing, which is exactly why a typo looks like an empty result set. `unknownFields` decides what happens: `suggest` (the default) adds a warning naming the nearest configured key, `error` rejects the query, and `ignore` stays silent. Warnings never make `hasErrors` true, so the query still applies.

Construction decodes the field configuration with Effect Schema, so a JavaScript consumer that passes a mistyped `type`, a missing `label`, or non-string `options` gets a typed `QueryConfigurationError` naming the offending path instead of a field that silently matches the wrong rows. TypeScript consumers are already checked and never reach this path. Field keys must additionally be nonempty and unique, and every field needs exactly one accessor, which are domain rules Schema cannot express.

## Opt-in Effect core

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

Errors are `Data.TaggedError` subclasses. Handle expected failures with `Effect.catchTag` or `Effect.result` / `Result.match`; defects such as throwing record accessors are not silently swallowed.

Advanced users can import `toQueryEngineAdapter` from `react-lucene-query/core` to reuse an existing Effect engine in React. Normal consumers use only `createQueryEngine` from the main entry. The React adapter catches **only** `InvalidQueryError` when deriving an inert predicate for invalid externally controlled applied state. `engine.facets` is the one deliberate exception on that plain facade: it throws the typed `InvalidQueryError`, because counting values through an inert "matches nothing" predicate would report every option as unavailable, which reads as a real result. React code does not take that path — `Query.Root` counts through the tolerant `compile`.

`InvalidQueryError` is declared with `Schema.TaggedError` rather than `Data.TaggedError`, because it is the one error a server sends back to a client: `Schema.encodeSync(InvalidQueryError)(error)` produces the wire shape and `Schema.decodeUnknownEffect(InvalidQueryError)(payload)` returns the error itself, so a server and its client cannot restate the same fields twice. `QueryConfigurationError` never crosses a wire and stays a plain `Data.TaggedError`.

`QueryEngine.make` and `engine.search` are traced, so a misconfigured schema and an adapter call show up in a span. `compile`, `filter` and `facets` are untraced-eager: they are pure CPU over caller data and run on every keystroke.

### Backend execution seam

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
The library does not define a backend protocol or SQL translation.

Pure exports also include `tokenize`, `tokenValue`, `parseQuery`, `hasErrors`, `compileQuery`, `tryCompileQuery`, `matchesQuery`, `filterRecords`, `facetCounts`, `listClauses`, `toggleClause`, `escapeTerm`, `escapeFieldName`, `fieldClause`, `and`, `or`, `not`, `readPath`, `fieldValues`, `parseDate`, `parseNumber`, `getSuggestions`, and `applySuggestion`. Low-level AST evaluators assume already validated input; never execute a partial AST from an invalid query.

`getSuggestions` returns `Option<SuggestionList>`: "no completion here" is an answer, not a missing value. Use `Option.getOrUndefined` at a React boundary.

### Compiling a node you built yourself

`parseQuery` validates a node before `compileQuery` ever sees it, so parsed text cannot reach a compile failure. A hand-built AST can: a wildcard escape that never closes, a fuzzy distance above two, a proximity that is not an integer. Those failures are typed, not bare exceptions.

| Call              | Result                                                                  |
| ----------------- | ----------------------------------------------------------------------- |
| `compileQuery`    | `(record: T) => boolean`, throws `QueryValueError` / `RegexSyntaxError` |
| `tryCompileQuery` | `Result<(record: T) => boolean, QueryValueError \| RegexSyntaxError>`   |

`tryCompileQuery` is the seam to use when the AST is not the parser's: `Result.isFailure` gives you the reason instead of a `catch`. The engine uses it internally, so an invalid query becomes an `InvalidQueryError` diagnostic rather than escaping as an Effect defect.

## Off-main-thread filtering

Filtering a large record set on the keystroke blocks the input thread. The `/worker` entry moves parsing, suggestion, clause listing, and filtering to a worker.

The default client loads a bundled, self-contained worker and initializes it with your path-only fields and unknown-field policy before the first query.

```ts
// main thread
import { createQueryWorkerSearch } from 'react-lucene-query/worker'

const search = createQueryWorkerSearch({ fields })
const rows = await search.filter('status:ready', records)
```

For a custom analyzer or a bundler-specific worker entry, configure a module explicitly:

```ts
// query.worker.ts
import { createWorkerEngine, serveQueryWorker } from 'react-lucene-query/worker'

const engine = createWorkerEngine({ fields }) // fields use `path`, never `read`
serveQueryWorker(engine, self)

// main thread
const search = createQueryWorkerSearch({
  fields,
  worker: new Worker(new URL('./query.worker.ts', import.meta.url), { type: 'module' }),
})
```

Worker engines refuse a `read` accessor and name the offending field. The default client also rejects `analyze` callbacks, which cannot be cloned; custom modules can define them locally. An explicit `worker` or `workerUrl` owns its configuration. Every call is correlated by id, so out-of-order answers resolve the correct promise. Worker load/deserialization errors reject outstanding and future calls rather than hanging. Filtering needs a complete query: an invalid one fails the request instead of answering with an empty result the caller would report as "nothing matched". `handleRequest` is exported so the protocol can be tested, or driven, without a `Worker`.

The message is **the one untrusted input in the package**, so it is decoded before the engine sees it. Requests and responses are Effect Schemas and the exported `WorkerRequest` / `WorkerResponse` types are derived from them, which means a field added to one side cannot be forgotten by the other.

- Decoding is strict: a missing required field, a mistyped `caret`, an unexpected key, or two payloads in one message is refused rather than matching a neighbouring shape.
- A success response echoes the call `type` it answers, so a client can never read `matches` off a `parse` answer.
- A refused message is answered with a failure response carrying the id it had, or `-1` when no id could be read. An unreadable answer is fatal to every outstanding request rather than left to wait forever.
- `isWorkerRequest` decodes untrusted messages; `handleRequest` accepts decoded query calls. `serveQueryWorker` handles the initialization handshake.

## Optional CodeMirror

Install the optional peers explicitly before importing the adapter:

```sh
bun add @codemirror/autocomplete @codemirror/commands @codemirror/lint @codemirror/state @codemirror/view
```

```tsx
import { QueryCodeMirror } from 'react-lucene-query/codemirror'

;<Query.Root {...rootProps}>
  <QueryCodeMirror label="Query" placeholder="status:ready" extensions={yourExtensions} />
  <Query.Diagnostics />
  <Query.Submit />
  <Query.Clear />
</Query.Root>
```

The adapter owns EditorView setup/cleanup, external-value synchronization, history, syntax roles, diagnostics, completion, and Enter-to-apply. It accepts normal container attributes plus `label`, `placeholder`, `extensions`, and `disabled`. Keep extension-array identity stable. CodeMirror itself renders the completion popup; do not also render `Query.Suggestions` beside it. It is a separate entry point, so the main/headless entry does not load CodeMirror.

## Supported syntax

This library implements the classic Lucene query language, verified against the grammar and conformance cases of [bripkens/lucene](https://github.com/bripkens/lucene). It does not reproduce Apache Lucene index execution, analyzers, or scoring.

| Syntax                                   | Meaning                                                     |
| ---------------------------------------- | ----------------------------------------------------------- |
| `status:ready`                           | Exact value; `keyword` fields compare case-sensitively      |
| `carrier:"North Star"`                   | Phrase; escape quotes and backslashes with `\`              |
| `north`                                  | Analyzed term across `freeText` fields                      |
| `carrier:north*`, `carrier:n*rth`        | Wildcards over complete tokens; `?` matches one character   |
| `north\*`                                | An escaped wildcard is a literal character                  |
| `units:[20 TO 100]`                      | Inclusive range                                             |
| `units:{20 TO 100}`, `units:[20 TO 100}` | Exclusive and mixed bounds                                  |
| `units:[* TO 100]`, `units:[20 TO *]`    | Open bounds; a quoted `"*"` stays a literal bound           |
| `due:2026-10`, `due:[2026-10 TO *]`      | Date literals and ranges over a `date` field                |
| `carrier:/no.*th/`                       | Lucene regular expression, matched against complete tokens  |
| `north~`, `north~1`, `north~0.8`         | Fuzzy term: up to two edits, or a legacy similarity         |
| `"north star"~10`                        | Phrase proximity                                            |
| `a^2`, `(a b)^2`                         | Boost; it round-trips but local filtering does not rank     |
| `a AND b` / `a b`                        | Explicit / implicit conjunction                             |
| `a OR b`                                 | Disjunction                                                 |
| `+a`                                     | Required clause                                             |
| `NOT a` / `-a` / `!a`                    | Prohibited clause                                           |
| `a AND NOT b`                            | Conjunction with a prohibited clause                        |
| `(a OR b) AND c`                         | Grouping                                                    |
| `status:(ready OR delayed)`              | Field group; the field is inherited into every descendant   |
| `*:*`                                    | Match every record                                          |
| `foo\~bar:baz`                           | Any reserved character can be escaped, in fields and values |

Keywords are uppercase. `&&` and `||` are aliases for `AND` and `OR`. Non-reserved `<` and `>` are ordinary term characters, never comparisons.
Unknown fields are valid syntax and simply match no records; `unknownFields` decides whether the engine also warns about them.
Values are never validated against a type: `units:many` is a legal query that matches nothing, because `many` is not one of the field's indexed values.
A Boolean group with only prohibited clauses matches no records, exactly like Apache Lucene.

Not supported: scoring or ranking, stop words, and index execution. Stemming, diacritic folding, and CJK segmentation are available per field through `analyze`.

The parser rejects queries over **32,768 UTF-16 code units**, **4,096 tokens**, or **100 nested conditions**. Suggestions use the same text/token budgets. Public standalone tokenization is a low-level helper without these budgets.

`stringifyQuery(node)` exports canonical Lucene text from a parsed AST. It re-encodes occurrence, grouping, and escaping from the tree rather than returning the original source, so `parse → stringify → parse` preserves meaning but not whitespace.

Local analysis defaults to a fixed lowercase Unicode letter/digit tokenizer with consecutive positions. It is not `StandardAnalyzer`: there is no stemming, stop-word removal, or CJK segmentation unless a field supplies `analyze`.

## Performance and composition notes

- Predicates and wildcard literal pieces are compiled once per applied query, not per record.
- Field wildcard matching avoids regular-expression backtracking.
- A regular expression is determinized once per pattern. Draft validation and applied compilation share that automaton instead of building it twice. The cache is bounded and cleared wholesale when full, so it never grows without limit.
- Draft parsing, applied compilation, and filtering are memoized independently in React.
- Value suggestion counts are indexed lazily in a `WeakMap` per immutable records-array identity and field.
- For large/remote datasets, provide `Query.Root.getSuggestions` or use `getSuggestions` with `SuggestionOptions.getValues` and `limit`; use `mode: 'async'` or the Effect adapter seam instead of filtering every record on every keystroke.
- Facet counts run once per applied query over the records it already selects, so a filter panel costs one pass, not one pass per option.
- The main, styled, CodeMirror, worker, and React-free core are independent public entries with shared internal chunks, so provider context and error-class identity remain consistent.
- React entry wrappers preserve `'use client'`; the core and the worker entry remain usable on servers and workers.

## Development

```sh
bun run check-types    # native TypeScript 7
bun run lint           # Oxlint, including anti-slop + anti-slop-effect
bun run format:check   # oxfmt
bun run test           # Bun + Happy DOM / Testing Library
bun run build          # ESM, declarations/maps, compiled CSS
bun run build:example
bun run check:package   # installed tarball: core, React, optional CodeMirror
bun run example:backend # real loopback HTTP adapter
bun run check          # all checks above
bunx playwright install chromium
bun run test:browser   # requires build:example; desktop, mobile, forced colors
bun run check:all      # check plus browser regressions
```

Browser checks run against the production playground.
They cover completion, draft/application state, clear, external changes, keyboard focus, and textarea/mirror geometry.
Chromium emulates mobile viewports and forced colors.
These checks do not replace native Windows or screen-reader checks.

The package check creates and removes a temporary application outside the repository.
It installs the packed library, checks public declarations, renders React consumers, and builds isolated bundles.
It checks the core without React and the main/styled entries without CodeMirror peers.
It then installs CodeMirror peers and checks shared React context.
Registry access or a populated Bun cache is required.
The React consumer uses server rendering; no Next.js or RSC framework check is claimed.

The pinned [anti-slop](https://github.com/dmmulroy/anti-slop) plugin is vendored under `tools/oxlint/anti-slop`. All generic rules, the opt-in Effect rules, and `oxc/no-accumulating-spread` run as errors. Vendored code is excluded from project linting/formatting and the published package. See its `UPSTREAM.md` for revision and licensing.

The language originated in a query-search POC and has been separated from application-specific data, routing, styling, and imports. Public interfaces here intentionally replace the application's feature-level contracts.

## Release preparation

The package remains at `0.1.0`. Nothing has been published by this work.
Use SemVer and set the intended version in `package.json` before release verification.
For pre-stable releases, use minor versions for API changes and patch versions for compatible fixes.
The workflow does not change versions, commit files, or create tags.

Run **Release verification** from GitHub Actions with the matching package version.
The workflow installs locked dependencies on Ubuntu and runs `check:all`.
It packs the checked build, runs `npm publish --dry-run`, and uploads `release.tgz`.
It never publishes and needs no registry credentials.

Use the same dry run locally:

```sh
bun run check:all
bun pm pack --ignore-scripts --filename release.tgz
npm publish ./release.tgz --dry-run --ignore-scripts --access public
```

Actual npm publication needs a separate maintainer decision and registry authentication.
Review the verified archive before publication.
Use a release tag that matches the package version when publishing.

## License

MIT. Vendored development tooling retains its own licenses and provenance.
