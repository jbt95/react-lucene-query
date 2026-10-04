# Development handoff

## Start here on another computer

```sh
git clone https://github.com/jbt95/react-lucene-query.git
cd react-lucene-query
git switch main
bun install --frozen-lockfile
bun run check
bun run dev
```

Use **Bun 1.4.2+**. Dependencies are locked in `bun.lock`; CI uses Bun 1.4.2. Typechecking and declaration generation use the native **TypeScript 7.0.2** compiler, not the older JavaScript compiler or the native-preview package.

No application repository, environment file, backend credentials, or external services are required. The playground uses synthetic records.

## User intent and latest API decision

The goal is a working, independent, reusable query-search library: scalable, composable, headless first, with optional styled UI and CodeMirror.

**Effect must not appear in normal consumer setup.** The playground and primary README examples now use:

```ts
import { createQueryEngine } from 'react-lucene-query'

const engine = createQueryEngine({ fields, today: '2026-10-24' })
```

Do not revert this to a two-step `Effect.runSync(QueryEngine.make(...))` followed by `toQueryEngineAdapter(...)`.

The main entry exports a plain `QueryEngine<T>` type and synchronous creation, parsing, compilation, filtering, and suggestions. It does **not** export the Effect engine's `QueryEngine.make` value or `toQueryEngineAdapter`.

Effect still powers the internals. Advanced consumers opt in explicitly through `react-lucene-query/core`, which exports `QueryEngine.make`, typed failures, `SearchAdapter`, and `toQueryEngineAdapter`. That entry is React-free.

## Completed implementation

- Schema-driven text, enum, number, date, and boolean fields.
- Tokenization, tolerant parsing, diagnostics, syntax roles, and caret-aware completion.
- Explicit/implicit AND, OR, NOT/unary minus, grouping, quoted values, field lists, wildcard terms, numeric/date comparisons, inclusive ranges, and relative dates.
- Typed Effect configuration/query failures and a backend execution seam preserving adapter result/error/environment types.
- Plain consumer facade; invalid configuration throws the domain error rather than a runtime `FiberFailure` wrapper.
- React draft/applied state separation; invalid drafts never replace applied queries.
- Headless `Query.*` primitives, hooks, context, refs, consumer event composition, keyboard navigation, and IME handling.
- Optional Tailwind v4 styled field and compiled CSS without global Preflight.
- Optional CodeMirror editor with completion, diagnostics, history, syntax roles, and external-value synchronization.
- Responsive playground with styled/headless/lazily loaded CodeMirror modes.
- Oxlint, oxfmt, pinned vendored anti-slop tooling, native TypeScript 7, focused tests, build scripts, MIT license, README, and GitHub Actions CI.

The original application checkout was not edited by this work.

## Architecture map

| Location                                | Purpose                                                        |
| --------------------------------------- | -------------------------------------------------------------- |
| `src/core/`                             | Language primitives, field validation, matching, Effect engine |
| `src/core.ts`                           | Advanced React-free public entry                               |
| `src/query-engine-adapter.ts`           | Plain facade and the internal synchronous Effect boundary      |
| `src/use-query-search.ts`               | Draft/applied ownership, validation, memoized local filtering  |
| `src/use-query-editor.ts`               | Caret, focus, selection, completion, keyboard/IME controller   |
| `src/query-context.ts`, `src/query.tsx` | Composable context and headless primitives                     |
| `src/styled.tsx`, `src/styles.css`      | Optional styled field; `rlq:` utility prefix                   |
| `src/codemirror.tsx`                    | Optional CodeMirror integration                                |
| `src/index.ts`                          | Normal consumer entry; do not expose Effect setup here         |
| `tests/`                                | Bun + Happy DOM / Testing Library; synthetic fixtures          |
| `example/`                              | Vite playground                                                |
| `scripts/build.ts`                      | Shared ESM chunks and public entry wrappers                    |
| `tools/oxlint/anti-slop/`               | Vendored development plugin and retained licenses/provenance   |

Public entries are `react-lucene-query`, `/core`, `/styled`, `/codemirror`, and `/styles.css`.

## Important invariants

1. Keep engines, field schemas, records, and records arrays stable/immutable. Suggestion counts are lazily cached by records-array identity and field in a WeakMap.
2. Parsing is tolerant; execution must not use a partial AST from a query with error diagnostics.
3. Compile predicates and wildcard pieces once per applied query. Wildcards use literal matching rather than backtracking regular expressions.
4. Parser budgets are 32,768 UTF-16 code units, 4,096 tokens, and 100 nested conditions. Oversized input is rejected before tokenization. Independent negations do not accumulate nesting depth. Suggestions also enforce text/token budgets.
5. Engines capture their local date on creation, unless `today` is supplied. The playground intentionally fixes it to `2026-10-24`; recreate an engine when its date anchor needs to advance.
6. Main React APIs return plain values; direct Effect composition is opt-in under `/core`.
7. Preserve typed Effect failures and adapter environments; do not add broad catch-all recovery, unsafe type escapes, or unnecessary service scaffolding.
8. Keep all entry points in one split library build. Independent bundling can duplicate React context or domain error classes across entries.
9. Bun strips source directives, so the build emits thin `'use client'` wrappers for React entries. The core wrapper must not have that directive. Source files themselves intentionally omit it to avoid Vite directive/sourcemap warnings.
10. Generated `dist` is cleaned before building and is not committed. Source is included in the package so declaration maps resolve; vendored tooling/tests/example are excluded from the package.
11. Styled textarea and mirror must have identical font, padding, wrapping, and bounds. Scoped unlayered text metrics defend against generic consumer form resets.
12. CodeMirror's completion interaction delay is zero so Tab immediately after Ctrl/Cmd+Space can accept a completion.

## Verification completed before handoff

`bun run check` passed, including:

- Native TypeScript typecheck.
- Oxlint with warnings denied and anti-slop/Effect rules enabled.
- oxfmt formatting check.
- **47 passing tests, 0 failures, 107 assertions**.
- Library JavaScript/declaration/CSS build.
- Production playground build, without the earlier directive/sourcemap warnings.

Additional manual verification:

- Playwright: styled/headless/CodeMirror filtering, invalid draft preservation, clear, keyboard completion, Escape/reopen, and mobile wrapping.
- CodeMirror Tab completion produced `carrier:`; Enter submission produced expected results.
- Textarea/mirror metrics and bounds matched, including long queries at mobile widths.
- Browser checks reported no application runtime errors.
- Built-package SSR smoke: a main-entry `Query.Root` and CodeMirror-entry child shared context correctly.
- Built exports: main entry did not expose Effect setup, and error-class identity was shared with `/core`.
- Static dependency traversal: core had no React dependency; main/styled did not import CodeMirror.
- `bun pm pack --dry-run --ignore-scripts`: 74 files, approximately 0.33 MB unpacked, with README/LICENSE/source/declarations/CSS and no vendored development tooling.
- `bun install --frozen-lockfile` passed.

One test deliberately throws when primitives are rendered outside their root; React prints expected error-boundary diagnostics even though that test passes.

Leadline analyzed 17 source files / 186 functions. Largest cognitive-complexity hotspots remain the keyboard dispatcher (25), unary parser (24), AND parser (17), and suggestion field-context detector (17). These are review targets, not a claim that a complexity gate passed. No coverage-backed CRAP metrics were generated.

Subagent tools were unavailable in this session; a fresh-context automated reviewer was not run.

## Known tooling note

Bun blocked the optional `@parcel/watcher` postinstall. All builds/checks worked without trusting it. Do not blindly trust all lifecycle scripts; investigate only if a new platform actually needs this watcher to build.

CodeMirror peers are optional and documented in README. Install its five peer packages only if using that entry. CI dependencies include them for development.

## Suggested continuation

The extraction is working; there is no known failing check. The next tasks are optional hardening/release work, not unfinished mandatory migration:

1. Run the CI workflow on GitHub/Linux and resolve any cross-platform issues. Local validation was on macOS ARM64.
2. Review public declarations/package behavior in a separate real React application, including an RSC framework if that matters to the consumer.
3. Add persistent browser tests for CodeMirror and responsive/forced-color behavior; current browser checks were manual tool-driven checks, not a committed Playwright suite.
4. Expand tests for date-boundary/low-level-helper edge cases and adversarial query shapes. Consider coverage measurements before complexity-driven refactoring.
5. Add a realistic backend adapter example if required; today the library supplies the seam, not HTTP/SQL translation or a backend runtime.
6. Consider improvements to parser/keyboard hotspots only where they clarify behavior; do not split functions just to game metrics.
7. Decide npm publishing/versioning and release automation. **Nothing was published to npm**, and no deployment was requested.

## Working commands

```sh
bun run test
bun run check-types
bun run lint
bun run format:check
bun run format
bun run build
bun run build:example
bun run check
bun pm pack
```

The packaged tarball is ignored by Git. To try it in another application, install its absolute path as documented in README.

This handoff is included in the same initial `main` commit as the implementation. Consult `git log -1` for the exact commit and `git status --short` before continuing.
