# Development and release verification

[← README](../README.md#appendix) · [Quick start](../README.md#quick-start)

```sh
bun run check-types    # native TypeScript 7
bun run lint           # Oxlint, including anti-slop + anti-slop-effect
bun run format:check   # oxfmt
bun run test           # Bun + Happy DOM / Testing Library; PostgreSQL integration skipped by default
bun run test:postgres  # optional parity check against a dedicated loopback instance on port 55432
bun run build          # ESM, declarations/maps, compiled CSS
bun run build:example
bun run check:package   # installed tarball: core, query outputs, React, optional CodeMirror
bun run example:backend # real loopback HTTP adapter
bun run check          # default checks above; PostgreSQL remains opt-in
bunx playwright install chromium
bun run test:browser   # requires build + build:example; desktop, mobile, forced colors
bun run check:all      # check plus browser regressions
```

Browser checks run against the production playground.
They cover completion, draft/application state, clear, external changes, keyboard focus, and textarea/mirror geometry.
Chromium emulates mobile viewports and forced colors.
These checks do not replace native Windows or screen-reader checks.

The package check creates and removes a temporary application outside the repository.
It installs the packed library, checks public declarations, renders React consumers, and builds isolated bundles.
It checks the core and optional JSON/PostgreSQL outputs without React, and the main/styled
entries without CodeMirror peers.
It then installs CodeMirror peers and checks shared React context.
Registry access or a populated Bun cache is required.
The React consumer uses server rendering; no Next.js or RSC framework check is claimed.

The pinned [anti-slop](https://github.com/dmmulroy/anti-slop) plugin is vendored under `tools/oxlint/anti-slop`. All generic rules, the opt-in Effect rules, and `oxc/no-accumulating-spread` run as errors. Vendored code is excluded from project linting/formatting and the published package. See [UPSTREAM.md](https://github.com/jbt95/react-lucene-query/blob/main/tools/oxlint/anti-slop/UPSTREAM.md) for revision and licensing.

The language originated in a query-search POC and has been separated from application-specific data, routing, styling, and imports. Public interfaces here intentionally replace the application's feature-level contracts.

## Release preparation

The package remains at `0.1.0`. Pushing changes to `main` does not publish the package to npm.
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

Related: [Local setup](getting-started.md) · [License](../LICENSE)
