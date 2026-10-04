# Anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Commit: c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b
- Copied: canonical `src/**` and root `LICENSE` from the commit archive.
- Destination: `tools/oxlint/anti-slop/` (the upstream `src/` prefix is removed).
- Nested ESLint Stylistic license and provenance are preserved.
- Local deviations: none. All generic rules are enabled. The opt-in Effect rules are also enabled because the core uses Effect.
- Development-only: excluded from package files, formatting and application linting.

Review upstream changes before replacing these files; preserve future local customizations.
