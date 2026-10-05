# react-lucene-query

[![npm version](https://img.shields.io/npm/v/react-lucene-query?label=npm&color=cb3837&logo=npm)](https://www.npmjs.com/package/react-lucene-query)
[![CI](https://img.shields.io/github/actions/workflow/status/jbt95/react-lucene-query/ci.yml?label=CI&logo=github)](https://github.com/jbt95/react-lucene-query/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![React](https://img.shields.io/badge/react-18%20%7C%2019-61dafb?logo=react)](https://react.dev)
[![Bun](https://img.shields.io/badge/bun-1.4.2%2B-black?logo=bun)](https://bun.sh)
[![Types](https://img.shields.io/badge/types-TypeScript-3178C6?logo=typescript)](https://www.typescriptlang.org)
[![Bundle](https://img.shields.io/badge/size-637%20kB-informational)](https://www.npmjs.com/package/react-lucene-query)
[![Effort](https://img.shields.io/badge/maintained-yes-brightgreen)](https://github.com/jbt95/react-lucene-query)

[Quick start](#quick-start) · [Fields](docs/fields.md) · [Query syntax](docs/query-syntax.md) · [React integration](docs/react.md) · [Query outputs](docs/query-outputs.md) · [All guides](#appendix)

Lucene-style query search for React. Define fields once to drive suggestions, validation, and filtering. Use the ready-made search field below, or compose your own headless UI.

This filters your records; it is not an Apache Lucene index and does not provide scoring or ranking.

Optional, React-free [query output modules](docs/query-outputs.md) translate validated queries into versioned JSON trees or parameterized PostgreSQL conditions. Your application owns backend execution and authorization.

## Install

```sh
npm install react-lucene-query
```

Then add the stylesheet once, if you use the styled editor:

```ts
import 'react-lucene-query/styles.css'
```

React 18.3 or 19 is required. CodeMirror is optional and only needed for the `react-lucene-query/codemirror` entry point. See [getting started](docs/getting-started.md) for details.

## Try it locally

Requires Bun 1.4.2 or newer.

```sh
git clone https://github.com/jbt95/react-lucene-query.git
cd react-lucene-query
bun install
bun run dev
```

The playground includes styled, headless, and CodeMirror editors. See [local package installation](docs/getting-started.md) to work against a checkout instead of the npm release. React 18.3 or 19 is required.

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
  { key: 'id', label: 'Order', type: 'keyword', path: 'id', freeText: true },
  {
    key: 'status',
    label: 'Status',
    type: 'keyword',
    path: 'status',
    options: ['ready', 'delayed'],
  },
  { key: 'notes', label: 'Notes', type: 'text', path: 'notes', freeText: true },
]

// Keep the engine outside render, or memoize it for dynamic schemas.
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
        summary={`${search.results.length} matching orders`}
      />
      <ul>
        {search.results.map((order) => (
          <li key={order.id}>{order.id}</li>
        ))}
      </ul>
    </>
  )
}
```

Typing edits the **draft**. Enter/Search applies a valid query; invalid drafts leave the current results unchanged. Clear applies an empty query and shows all records.

| Query                          | Finds                                   |
| ------------------------------ | --------------------------------------- |
| `status:ready`                 | Orders with an exact status             |
| `status:(ready OR delayed)`    | Either status                           |
| `notes:"ship today"`           | A phrase in the notes                   |
| `status:ready AND notes:ship*` | Ready orders with a matching note token |

Keep schemas and records immutable; replace the records array when data changes.

## Appendix

| Guide                                      | Details                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| [Getting started](docs/getting-started.md) | Local installation, dependencies, and the playground                              |
| [Fields and analysis](docs/fields.md)      | Types, accessors, multi-valued fields, and custom analyzers                       |
| [Query syntax](docs/query-syntax.md)       | Operators, phrases, patterns, ranges, and limits                                  |
| [Query builders](docs/query-building.md)   | Safe escaping, grouping, and condition removal                                    |
| [React integration](docs/react.md)         | Headless components, async search, URLs/history, facets, styling, and CodeMirror  |
| [Engine API](docs/engine.md)               | Parsing, filtering, suggestions, facets, and performance                          |
| [Query outputs](docs/query-outputs.md)     | Versioned JSON trees, parameterized PostgreSQL conditions, and supported features |
| [Effect core](docs/effect.md)              | React-free execution, typed errors, and backend adapters                          |
| [Workers](docs/workers.md)                 | Off-main-thread execution, portable schemas, and the protocol                     |
| [Development](docs/development.md)         | Checks, package verification, tooling, and release preparation                    |

## License

[MIT](LICENSE). Vendored development tooling retains its own licenses and provenance.
