# react-lucene-query

Schema-driven, Lucene-style query search with an **Effect core** and **composable React primitives**.

Define searchable fields once. The same definitions drive parsing, diagnostics, syntax roles, suggestions, and local matching. Keep the headless primitives, use the optional Tailwind field, or bring CodeMirror.

> This implements a focused Lucene-style grammar, not Apache Lucene compatibility. This repository is the initial library extraction; it has not been published to npm.

## Run the playground

Requires Bun 1.4.2 or newer. Typechecking and declaration generation use **TypeScript 7.0.2's native Go compiler**.

```sh
git clone https://github.com/jbt95/react-lucene-query.git
cd react-lucene-query
bun install
bun run dev
```

The playground demonstrates styled, headless, and lazily loaded CodeMirror presentations against the same query state. Its relative-date anchor is fixed to `2026-10-24` for reproducibility.

To use the library in another local project:

```sh
bun run check
bun pm pack
# In your application:
bun add /absolute/path/to/react-lucene-query/react-lucene-query-0.1.0.tgz
```

React 18.3 or 19 is a peer dependency. Effect 4 and the Temporal polyfill are runtime dependencies. Consumers do not need TypeScript 7 at runtime, though declaration compatibility is currently verified with TypeScript 7.

## Quick start

```tsx
import { createQueryEngine, useQuerySearch, type QueryField } from 'react-lucene-query'
import { QuerySearchField } from 'react-lucene-query/styled'
import 'react-lucene-query/styles.css'

interface Order {
  id: string
  status: string
  units: number
}

const fields: readonly QueryField<Order>[] = [
  { key: 'id', label: 'Order', type: 'text', read: (row) => row.id, freeText: true },
  {
    key: 'status',
    label: 'Status',
    type: 'enum',
    options: ['ready', 'delayed'],
    read: (row) => row.status,
  },
  { key: 'units', label: 'Units', type: 'number', read: (row) => row.units },
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

`QueryField<T>` has `key`, `label`, `type`, and a `read(record)` accessor. Types are `text`, `enum`, `number`, `date`, and `boolean`.

- Mark fields `freeText: true` to include them in unqualified text searches.
- Enum `options` feed validation and suggestions.
- Field lookup is case-insensitive. Keys must match `[a-z_][a-z0-9_.]*` and be unique ignoring case.
- Accessors return a string, number, boolean, null, or undefined. Missing values do not match field terms.
- Date accessors should return ISO dates; an ISO timestamp's first ten characters are matched as its date.
- Treat schemas, records, and records arrays as immutable. Replace the records array when values change.

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
| `Query.Provider`               | Supply a `QueryContextValue` from your own controller.                                                           |

`useQueryContext()` exposes editor state for your own presentation. `useQueryEditor()` lets you supply parsing and suggestion results yourself. Do not change glyph metrics between an input and its mirrored highlight.

Keyboard behavior: Arrow keys navigate open suggestions, Tab accepts, Enter accepts a selected completion or submits, Escape dismisses, and Ctrl/Cmd+Space reopens. Shift+Tab keeps normal backward focus navigation; IME composition is not submitted.

A visible label is required for accessibility. Headless consumers must label `Query.Input` and render `Query.Diagnostics` (or provide their own region with the controller's diagnostic ID).

### State control

`useQuerySearch` accepts controlled `value` / `appliedValue` independently, or uncontrolled `defaultValue` / `defaultAppliedValue`.

- `onValueChange(value)` receives draft changes.
- `onApply(value, parsed)` runs only on valid submissions.
- `setDraft` edits only the draft; `submit` applies; `apply` edits and submits; `clear` applies an empty query.
- `parsedDraft`, `parsedApplied`, `matches`, `isValid`, and `isPending` are derived.
- Records are optional for backend-only search. Invalid externally controlled applied values produce no local matches.
- Do not switch between controlled and uncontrolled ownership during the component lifetime.

### Optional styling

Import `react-lucene-query/styles.css` once when using `QuerySearchField`. It is compiled Tailwind v4 CSS, so your application does not need a Tailwind build. Utilities use the `rlq:` prefix; there is no global Preflight reset.

Use `className` for layout and override scoped CSS variables such as `--rlq-accent`, `--rlq-surface`, `--rlq-text`, `--rlq-border`, and `--rlq-error`. `label`, `placeholder`, `disabled`, and `summary` customize the ready-made field. Suggestions stay in document flow rather than requiring a portal.

## Plain engine API

Normal React consumers never need to import Effect or run a runtime:

```ts
import { createQueryEngine } from 'react-lucene-query'

const engine = createQueryEngine({ fields, today: '2026-10-24' })
const parsed = engine.parse('status:ready')
const rows = engine.filter('status:ready', orders)
const suggestions = engine.suggest('sta', 3, orders)
```

The main entry's `QueryEngine<T>` type describes this plain facade. Its methods return ordinary values. Invalid queries retain diagnostics and produce inert predicates / no matches; invalid configuration throws `QueryConfigurationError`, not an Effect runtime wrapper.

## Opt-in Effect core

`react-lucene-query/core` imports no React. Pure language helpers stay pure; engine construction and query execution use typed Effect failures.

```ts
import { Effect } from 'effect'
import { QueryEngine } from 'react-lucene-query/core'

const makeEngine = QueryEngine.make({ fields, today: '2026-10-24' })

const results = Effect.gen(function* () {
  const engine = yield* makeEngine
  return yield* engine.filter('status:ready AND units:>100', orders)
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

Errors are `Data.TaggedError` subclasses. Handle expected failures with `Effect.catchTag` or `Effect.result` / `Result.match`; defects such as throwing record accessors are not silently swallowed.

Advanced users can import `toQueryEngineAdapter` from `react-lucene-query/core` to reuse an existing Effect engine in React. Normal consumers use only `createQueryEngine` from the main entry. The React adapter catches **only** `InvalidQueryError` when deriving an inert predicate for invalid externally controlled applied state.

### Backend execution seam

`SearchAdapter<A, E, R>` is a function from validated `ParsedQuery` to `Effect<A, E, R>`. The adapter owns SQL/HTTP/search-index translation, authorization, encoding, and resources; the library does not invent a backend protocol or silently execute work inside React render.

```ts
import { Effect } from 'effect'
import { filterRecords, QueryEngine, type SearchAdapter } from 'react-lucene-query/core'

// This local adapter is runnable; substitute your own Effect-powered repository at this seam.
const today = '2026-10-24'
const searchOrders: SearchAdapter<readonly Order[]> = (parsed) =>
  Effect.sync(() => filterRecords(parsed.node, fields, orders, today))

const program = Effect.gen(function* () {
  const engine = yield* QueryEngine.make({ fields, today })
  return yield* engine.search('status:ready', searchOrders)
})
```

Connect `onApply` to your application's runtime or request-state layer for backend-only UI. Provide layers and cancellation at that boundary; this library does not run an asynchronous Effect with `runSync`.

Pure exports also include `tokenize`, `tokenValue`, `parseQuery`, `hasErrors`, `compileQuery`, `matchesQuery`, `filterRecords`, `getSuggestions`, and `applySuggestion`. Low-level AST evaluators assume already validated input; never execute a partial AST from an invalid query.

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

| Syntax                              | Meaning                                               |
| ----------------------------------- | ----------------------------------------------------- |
| `status:ready`                      | Case-insensitive exact field value                    |
| `carrier:"North Star"`              | Quoted value; escape quotes/backslashes with `\`      |
| `north` or `"North Star"`           | Case-insensitive substring across `freeText` fields   |
| `carrier:North*`                    | Field wildcard; every character except `*` is literal |
| `a AND b` / `a b`                   | Explicit / implicit conjunction                       |
| `a OR b`                            | Disjunction; AND binds more tightly                   |
| `NOT a` / `-a`                      | Negation; binds more tightly than AND                 |
| `(a OR b) AND c`                    | Grouping                                              |
| `status:(ready OR delayed)`         | Field value list                                      |
| `units:>=100`                       | Number/date comparisons: `>`, `>=`, `<`, `<=`         |
| `units:[20 TO 100]`                 | Inclusive number/date range                           |
| `units:-5`, `units:1.2e3`           | Signed/decimal/scientific numeric values              |
| `active:true` / `active:false`      | Boolean values                                        |
| `due:2026-10-24` / `due:24.10.2026` | ISO/display dates                                     |
| `due:[today TO today+7]`            | Relative dates with day offsets                       |

Keywords are uppercase. Unknown fields and invalid values produce diagnostics. Enum warnings can be non-blocking; error diagnostics block execution.

Not supported: fuzzy/proximity queries, regular-expression syntax, scoring/boosts, exclusive ranges, open-ended range bounds, analyzer/stemming semantics, or arbitrary Lucene escaping. Free-text `*` is literal rather than a wildcard.

The parser rejects queries over **32,768 UTF-16 code units**, **4,096 tokens**, or **100 nested conditions**. Suggestions use the same text/token budgets. Public standalone tokenization is a low-level helper without these budgets. Dates use the engine's captured local day unless an explicit ISO `today` is supplied; recreate the engine when the date anchor should advance.

## Performance and composition notes

- Predicates and wildcard literal pieces are compiled once per applied query, not per record.
- Field wildcard matching avoids regular-expression backtracking.
- Draft parsing, applied compilation, and filtering are memoized independently in React.
- Value suggestion counts are indexed lazily in a `WeakMap` per immutable records-array identity and field.
- For large/remote datasets, provide `Query.Root.getSuggestions` or use `getSuggestions` with `SuggestionOptions.getValues` and `limit`; use `onApply` and the Effect adapter seam instead of filtering every record on every keystroke.
- The main, styled, CodeMirror, and React-free core are independent public entries with shared internal chunks, so provider context and error-class identity remain consistent.
- React entry wrappers preserve `'use client'`; the core remains usable on servers/workers.

## Development

```sh
bun run check-types    # native TypeScript 7
bun run lint           # Oxlint, including anti-slop + anti-slop-effect
bun run format:check   # oxfmt
bun run test           # Bun + Happy DOM / Testing Library
bun run build          # ESM, declarations/maps, compiled CSS
bun run build:example
bun run check          # all checks above
```

The pinned [anti-slop](https://github.com/dmmulroy/anti-slop) plugin is vendored under `tools/oxlint/anti-slop`. All generic rules, the opt-in Effect rules, and `oxc/no-accumulating-spread` run as errors. Vendored code is excluded from project linting/formatting and the published package. See its `UPSTREAM.md` for revision and licensing.

The language originated in a query-search POC and has been separated from application-specific data, routing, styling, and imports. Public interfaces here intentionally replace the application's feature-level contracts.

## License

MIT. Vendored development tooling retains its own licenses and provenance.
