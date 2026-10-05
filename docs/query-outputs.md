# Query outputs: JSON and PostgreSQL

[← README](../README.md#appendix) · [Engine](engine.md) · [Effect adapters](effect.md)

Query translation is separate from executing a search. The optional, React-free entries
`react-lucene-query/query-json` and `react-lucene-query/postgres` return pure Effect
`Result` values. They do not open connections, fetch records, or change local filtering.

## Versioned JSON

`toQueryJson(parsed)` exports a valid `ParsedQuery` as a version-1 `QueryDocument`.
The document contains only the query tree, not editor tokens, diagnostics, field accessors,
or source formatting. It preserves occurrence, raw values, ranges, patterns, and boosts.
Export checks the document's resource budget and verifies that canonical text can be parsed
without changing the tree. A valid editor query can still return a translation error if its
canonical representation exceeds parser limits; export never succeeds with an unimportable
document solely because canonicalization added syntax.

```ts
import { Result } from 'effect'
import { createQueryEngine } from 'react-lucene-query'
import { fromQueryJson, toQueryJson } from 'react-lucene-query/query-json'

const engine = createQueryEngine({ fields })
const exported = toQueryJson(engine.parse('status:ready'))

Result.match(exported, {
  onFailure: (error) => console.error(error.code, error.message),
  onSuccess: (document) => {
    const serialized = JSON.stringify(document)
    const input: unknown = JSON.parse(serialized)
    const restored = fromQueryJson(input, engine.fields, { unknownFields: 'error' })
    // Handle restored with Result.match before applying restored.success.text.
    console.log(restored)
  },
})
```

The document above is:

```json
{
  "version": 1,
  "node": {
    "type": "term",
    "field": "status",
    "value": { "kind": "term", "raw": "ready" }
  }
}
```

- An empty query uses `{ "version": 1, "node": null }` and means match-all.
- An unqualified term uses `field: null`.
- Open range bounds use `from: null` or `to: null`.
- Optional boosts, fuzzy distances, and phrase proximity are omitted when absent.
- Boolean nodes contain `clauses`, each with `occur: "must" | "should" | "must-not"` and a child `node`.
- Unknown versions, extra properties, malformed nodes, and invalid modifiers are rejected.

`fromQueryJson(input, fields, options?)` strictly decodes an unknown **object**, renders canonical
Lucene text, and revalidates it using the receiving application's fields and parser budgets.
Inputs must use plain data objects and arrays with own, enumerable, string-keyed data properties.
Custom prototypes, inherited wire properties, accessors, and hidden fields are rejected before
recursive decoding; null-prototype data objects are accepted.
It also checks that rendering and parsing preserve the tree: a wire wildcard that would become
an analyzed term, or a noncanonical clause structure, is rejected rather than silently reinterpreted.
The result is a new `ParsedQuery`; original whitespace and editor offsets are not retained.
Use this function rather than directly evaluating a client-supplied tree.

A bounded preflight rejects excessive input before recursive decoding: at most 32,768 values,
131,072 UTF-16 code units across string values and property names, and 400 JSON-container levels. Canonical text must additionally
satisfy the parser's existing text, token, and nesting limits. Bound request bodies before
`JSON.parse` as well; this function is not an HTTP body-size limiter.

The exported `QueryDocument` Effect Schema describes the wire shape and supports schema-based
tooling. **Shape decoding alone is not semantic or resource validation**; use `fromQueryJson`
at an execution boundary. Field definitions and custom analyzers belong to the receiving
application and are not included in the document. This format is not an Elasticsearch or
MongoDB query DSL.

## PostgreSQL conditions

`toPostgres(parsed, { fields, columns })` produces `{ sql, params }` for PostgreSQL.
`sql` is a condition without `WHERE` or `SELECT`, and placeholders start at `$1`.

```ts
import { Result } from 'effect'
import { createQueryEngine, type QueryField } from 'react-lucene-query'
import { toPostgres } from 'react-lucene-query/postgres'

interface Order {
  status: string
  units: number
}
const fields: readonly QueryField<Order>[] = [
  { key: 'status', label: 'Status', type: 'keyword', path: 'status' },
  { key: 'units', label: 'Units', type: 'number', path: 'units' },
]
const engine = createQueryEngine({ fields, unknownFields: 'error' })
const output = toPostgres(engine.parse('status:ready AND units:[100 TO 200]'), {
  fields: engine.fields,
  columns: {
    status: { column: 'status', type: 'text' },
    units: { column: 'units', type: 'number' },
  },
})

Result.match(output, {
  onFailure: (error) => console.error(error.code, error.field, error.feature),
  onSuccess: ({ sql, params }) => {
    // Execute with your driver's parameterized-query method, on the server.
    console.log(sql, params)
  },
})
```

This produces:

```ts
{
  sql: '(COALESCE("status" COLLATE "C" = $1::text, FALSE) AND COALESCE(("units" >= $2::double precision AND "units" <= $3::double precision), FALSE))',
  params: ['ready', 100, 200],
}
```

### Trusted field mappings and storage contract

Never derive identifiers from user query text or automatically translate a `read(record)`
function. `columns` is trusted application configuration keyed by searchable field key.
A string is **one** identifier, including dots; use an array for qualification:

```ts
{ column: ['orders', 'status'], type: 'text' } // "orders"."status"
```

Qualification arrays must contain one to four segments: column, table/column,
schema/table/column, or database/schema/table/column. PostgreSQL permits database qualification
only for the current database; the adapter does not verify object existence or database identity.
Each segment is independently quoted, including embedded quotation marks.
Empty identifiers, overqualified mappings, NULs, unpaired Unicode surrogates, and segments
exceeding PostgreSQL's standard 63-byte limit are rejected.
Inherited object properties are not mappings.

Mappings declare scalar storage:

| Query field | Mapping type  | Required database representation                                            |
| ----------- | ------------- | --------------------------------------------------------------------------- |
| `keyword`   | `text`        | Trimmed, nonempty scalar text, or SQL NULL for unindexed values             |
| `number`    | `number`      | Finite `double precision` values, or SQL NULL                               |
| `date`      | `timestamptz` | AD instants at millisecond precision, such as `timestamptz(3)`, or SQL NULL |

These are **caller-provided contracts**, not schema introspection. The adapter cannot detect a
record accessor returning arrays or calculated values. Do not map arrays, unnormalized strings,
numeric strings, Boolean columns, text dates, or mismatched calculated values to scalar columns
and expect local/backend equivalence. Normalize or materialize compatible scalar columns first.

Keyword equality uses PostgreSQL's `"C"` collation for case-sensitive comparison.
The adapter does not wrap columns in trimming, lowercasing, or parsing functions.
Date parameters carry explicit UTC offsets, independent of session time zone.
Non-AD translated date bounds, nonfinite numeric query values, NUL text, and unpaired Unicode surrogates
are rejected rather than passed to a driver that could fail or replace characters.

### Supported subset

- Keyword terms and phrases without proximity, matched by exact scalar equality.
- Numeric equality and inclusive, exclusive, mixed, and open ranges.
- Date terms as half-open precision windows, and ranges respecting whole-window bounds.
- Grouping and the parser's `must`, `should`, and `must-not` occurrence rules.
- Empty queries, `*:*`, and unqualified input across compatible `freeText` fields.
  Quote timestamp literals containing reserved punctuation: `due:"2026-10-24T14:00+02:00"`.

Missing values do not match positive clauses, but can match their negation.
A group containing only prohibited clauses matches nothing, as in the existing evaluator.
If a group has required clauses, its optional clauses do not affect filtering; their parameters
are omitted, but unsupported features in them still cause a translation error.

Unknown fields retain the language's match-none behavior unless parsing used
`unknownFields: 'error'`. Configured fields without a mapping are translation errors.
Unparseable number/date literals remain valid queries producing `FALSE`, not database cast errors.

Analyzed `text`, wildcards, fuzzy matching, Lucene regexes, phrase proximity, keyword ranges,
and boosts are explicitly unsupported in PostgreSQL output. Unqualified searches fail if
they would include an unsupported analyzed-text field. Features are never approximated with
substring matching or silently ignored.

### Errors and execution

Both output entries export `QueryTranslationError`, with `target`, `code`, `message`,
and optional `field` / `feature`. Codes distinguish invalid queries/JSON, resource budgets,
unsupported features, missing or invalid mappings, and unrepresentable backend values.

Translate after valid submission, for example in `onApply`; do not confuse SQL/JSON output
with `useQuerySearch.results`, which remains a records array.

The existing Effect execution seam can preserve translation failures:

```ts
import { Effect } from 'effect'
import { QueryEngine } from 'react-lucene-query/core'
import { toPostgres } from 'react-lucene-query/postgres'

const program = Effect.gen(function* () {
  const engine = yield* QueryEngine.make({ fields })
  return yield* engine.search('status:ready', (parsed) =>
    Effect.fromResult(toPostgres(parsed, { fields: engine.fields, columns })),
  )
})
```

`engine.search` currently compiles a local predicate before invoking the adapter; standalone
output functions need only a valid parse. No new engine configuration or plugin registry is required.
A future backend DSL can be another pure tree adapter without changing the React editor.

Production servers must revalidate incoming query text or JSON with their own fields and trusted
mappings. Parameterization is not authorization: the application still owns tenant restrictions,
table selection, joins, sorting, pagination, and execution. Never accept executable SQL from a browser.

## PostgreSQL equivalence tests

The ordinary test suite checks output, JSON round-trips, invalid drafts, capabilities, injection
resistance, dates, and clause occurrence without a database. A separate integration test compares
the local evaluator with actual PostgreSQL over synthetic scalar records, including NULLs.

It is skipped unless `QUERY_TEST_POSTGRES_PORT` is set. It connects only to `127.0.0.1`,
uses fixed `postgres` test identifiers and no application credentials, and writes only a
session-local temporary table inside a transaction.

For a **dedicated disposable** PostgreSQL 17 test instance, after approving its creation:

```sh
docker run --rm --name rlq-output-postgres \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p 127.0.0.1:55432:5432 postgres:17
# In another terminal, once PostgreSQL reports it is ready:
bun run test:postgres
# Stop the disposable instance when finished:
docker stop rlq-output-postgres
```

Do not point this test at an application or production database. The adapter does not require
Bun or a database driver in consumers; [Bun's built-in SQL client](https://github.com/oven-sh/bun/blob/bun-v1.4.2/docs/runtime/sql.mdx) is used only by this test.
