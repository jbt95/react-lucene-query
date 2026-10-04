import { rm } from 'node:fs/promises'

// dist is generated and gitignored; clear it so old hashed chunks cannot enter the package.
await rm('dist', { recursive: true, force: true })

const entries = ['index', 'core', 'styled', 'codemirror']

const result = await Bun.build({
  entrypoints: ['src/index.ts', 'src/core.ts', 'src/styled.tsx', 'src/codemirror.tsx'],
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

// Thin public entries preserve RSC directives without shifting sourcemaps or duplicating context.
for (const name of entries) {
  const directive = name === 'core' ? '' : "'use client';\n"
  await Bun.write(`dist/${name}.js`, `${directive}export * from './_${name}.js';\n`)
}
