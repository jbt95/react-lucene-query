import { rm } from 'node:fs/promises'

// dist is generated and gitignored; clear it so old hashed chunks cannot enter the package.
await rm('dist', { recursive: true, force: true })

const entries = ['index', 'core', 'styled', 'codemirror', 'worker']

const result = await Bun.build({
  entrypoints: [
    'src/index.ts',
    'src/core.ts',
    'src/styled.tsx',
    'src/codemirror.tsx',
    'src/worker.ts',
  ],
  outdir: 'dist',
  naming: '_[name].js',
  target: 'browser',
  format: 'esm',
  splitting: true,
  sourcemap: 'linked',
  packages: 'external',
  jsx: { development: false },
})

if (!result.success) throw new AggregateError(result.logs, 'Library build failed')

// A native worker cannot resolve bare package imports. Ship a self-contained bootstrap rather
// than another external-dependency wrapper; import.meta.url resolves it beside the client.
const workerEntry = await Bun.build({
  entrypoints: ['src/worker-entry.ts'],
  outdir: 'dist',
  target: 'browser',
  format: 'esm',
  packages: 'bundle',
  sourcemap: 'linked',
  minify: true,
})

if (!workerEntry.success) throw new AggregateError(workerEntry.logs, 'Worker entry build failed')

// Thin public entries preserve RSC directives without shifting sourcemaps or duplicating context.
for (const name of entries) {
  const directive = name === 'core' || name === 'worker' ? '' : "'use client';\n"
  await Bun.write(`dist/${name}.js`, `${directive}export * from './_${name}.js';\n`)
}
