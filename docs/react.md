# React integration

[← README](../README.md#appendix) · [Quick start](../README.md#quick-start)

The examples below reuse `engine`, `orders`, and `search` from the [quick start](../README.md#quick-start).

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

## State control

`useQuerySearch` accepts controlled `value` / `appliedValue` independently, or uncontrolled `defaultValue` / `defaultAppliedValue`.

- `onValueChange(value)` receives draft changes.
- `onApply(value, parsed)` runs only on valid submissions.
- `setDraft` edits only the draft; `submit` applies; `apply` edits and submits; `clear` applies an empty query.
- `parsedDraft`, `parsedApplied`, `results`, `isValid`, and `isPending` are derived. `matches` is an alias of `results`.
- Records are optional for backend-only search. Invalid externally controlled applied values produce no results.
- Do not switch between controlled and uncontrolled ownership during the component lifetime.

## Remote search

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

## Shareable links and recent searches

```tsx
const [fromUrl, setUrl] = useQueryUrlState({ key: 'q' })
const { entries, push, remove, clear } = useQueryHistory({ engine, value: search.applied })
```

`useQueryUrlState` preserves other URL parameters, the fragment, and navigation metadata. Keep a custom `storage` object stable between renders; changing `key` or `storage` reloads that history namespace.

`useQueryUrlState` keeps one query in the URL so a search survives a reload and travels in a shared link; it follows Back and Forward through `popstate`, and accepts `target` / `history` overrides. `useQueryHistory` records each applied query once, newest first, decodes what it reads rather than trusting storage, and accepts a `storage` override or `null` to stay in memory.

## Optional styling

Import `react-lucene-query/styles.css` once when using `QuerySearchField`. It is compiled Tailwind v4 CSS, so your application does not need a Tailwind build. Utilities use the `rlq:` prefix; there is no global Preflight reset.

Use `className` for layout and override scoped CSS variables such as `--rlq-accent`, `--rlq-surface`, `--rlq-text`, `--rlq-border`, and `--rlq-error`. `label`, `placeholder`, `disabled`, and `summary` customize the ready-made field. Suggestions stay in document flow rather than requiring a portal.

## Click-to-query and facets

Nobody types `status:ready`; they click it. The engine counts the values each field holds among the records a query already selects, so an option that would return nothing is not offered.

```tsx
<Query.Root
  engine={engine}
  records={orders}
  value={search.draft}
  applied={search.applied}
  parsed={search.parsedDraft}
  onValueChange={search.setDraft}
  onSubmit={search.submit}
>
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

Related: [Field definitions](fields.md) · [Query builders](query-building.md) · [Effect backend adapters](effect.md#backend-execution-seam)
