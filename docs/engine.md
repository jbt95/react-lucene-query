# Engine API and performance

[← README](../README.md#appendix) · [Quick start](../README.md#quick-start)

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

Related: [Field definitions](fields.md) · [React-free Effect core](effect.md) · [Workers](workers.md)
