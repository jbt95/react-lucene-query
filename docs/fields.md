# Fields and analysis

[← README](../README.md#appendix) · [Quick start](../README.md#quick-start)

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
import type { QueryField } from 'react-lucene-query'

interface Order {
  id: string
  tags: readonly string[]
  units: number
  due: string
  notes: string
}

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
    // Normalize `1,000` to `1000` before splitting into tokens.
    analyze: (value) =>
      value
        .replaceAll(',', '')
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? [],
  },
]
```

Related: [Query syntax](query-syntax.md) · [Worker-compatible fields](workers.md)
