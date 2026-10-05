# Getting started

[← README](../README.md#appendix) · [Quick start](../README.md#quick-start)

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

Next: [React integration](react.md) · [Field definitions](fields.md)
