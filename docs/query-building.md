# Building and removing queries

[← README](../README.md#appendix) · [Quick start](../README.md#quick-start)

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

## Removing a specific condition

Use `removeClause` to remove a parsed condition, including its phrase, range, pattern, or modifiers:

```ts
import { listClauses, parseQuery, removeClause } from 'react-lucene-query'

const [clause] = listClauses(parseQuery(query).node)

if (clause) removeClause(query, clause)
```

Related: [Query syntax](query-syntax.md) · [Chips and facets](react.md#click-to-query-and-facets)
