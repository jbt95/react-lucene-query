import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import manifest from '../package.json'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const temporary = await mkdtemp(join(tmpdir(), 'react-lucene-query-package-'))

const consumer = join(temporary, 'consumer')

const archive = join(temporary, 'library.tgz')

const packageDirectory = join(consumer, 'node_modules', manifest.name)

async function run(cwd: string, ...args: string[]) {
  console.log(`Package consumer: ${args.join(' ')}`)
  const process = Bun.spawn(args, { cwd, stdout: 'inherit', stderr: 'inherit' })
  const exitCode = await process.exited

  if (exitCode !== 0)
    throw new Error(`Package consumer command failed (${exitCode}): ${args.join(' ')}`)
}

async function writeConsumerFile(name: string, content: string) {
  await Bun.write(join(consumer, name), content)
}

// Registry packages use this checkout's dependency requirements, but never its node_modules.
const toolchain = {
  typescript: manifest.devDependencies.typescript,
  '@types/bun': manifest.devDependencies['@types/bun'],
}

const react = {
  react: manifest.devDependencies.react,
  'react-dom': manifest.devDependencies['react-dom'],
  '@types/react': manifest.devDependencies['@types/react'],
  '@types/react-dom': manifest.devDependencies['@types/react-dom'],
}

const codemirror = {
  '@codemirror/autocomplete': manifest.devDependencies['@codemirror/autocomplete'],
  '@codemirror/commands': manifest.devDependencies['@codemirror/commands'],
  '@codemirror/lint': manifest.devDependencies['@codemirror/lint'],
  '@codemirror/state': manifest.devDependencies['@codemirror/state'],
  '@codemirror/view': manifest.devDependencies['@codemirror/view'],
}

async function install(dependencies: Record<string, string>) {
  await writeConsumerFile(
    'package.json',
    JSON.stringify({
      name: 'packed-query-consumer',
      private: true,
      type: 'module',
      dependencies: { [manifest.name]: archive, ...toolchain, ...dependencies },
    }),
  )
  // Automatic peer installation would hide accidental React or CodeMirror dependencies.
  await run(consumer, process.execPath, 'install', '--ignore-scripts', '--omit=peer')
  assert(!(await lstat(packageDirectory)).isSymbolicLink(), 'Library must not be a source symlink')
  const installed = await realpath(packageDirectory)
  assert(installed.startsWith(`${await realpath(consumer)}${sep}node_modules${sep}`), installed)
}

async function assertAbsent(packages: readonly string[]) {
  for (const name of packages) {
    assert(
      !(await Bun.file(join(consumer, 'node_modules', name, 'package.json')).exists()),
      `Unexpected peer installed: ${name}`,
    )
  }
}

async function checkTypes(files: readonly string[]) {
  await writeConsumerFile(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        module: 'ESNext',
        moduleResolution: 'Bundler',
        jsx: 'react-jsx',
        strict: true,
        noUncheckedIndexedAccess: true,
        verbatimModuleSyntax: true,
        skipLibCheck: false,
        noEmit: true,
        types: ['bun'],
        allowImportingTsExtensions: true,
      },
      files,
    }),
  )
  // The pinned typescript package launches the native compiler through its tsc executable.
  await run(consumer, join(consumer, 'node_modules', '.bin', 'tsc'), '-p', 'tsconfig.json')
}

const data = `
import type { QueryField } from 'react-lucene-query/core'

export interface Item { readonly id: string; readonly units: number }
export const records: readonly Item[] = [
  { id: 'ready', units: 120 },
  { id: 'small', units: 5 },
]
export const fields: readonly QueryField<Item>[] = [
  { key: 'id', label: 'Identifier', type: 'keyword', freeText: true, read: record => record.id },
  { key: 'units', label: 'Units', type: 'keyword', read: record => record.units },
]
`

const worker = `
import assert from 'node:assert/strict'
import { createQueryWorkerSearch, createWorkerEngine, handleRequest, isWorkerRequest } from 'react-lucene-query/worker'
import type { ParsedQuery, QueryField } from 'react-lucene-query/core'
import { records, type Item } from './data.ts'

// A worker schema must survive structured cloning, so every field reads by path.
const portableFields: readonly QueryField<Item>[] = [
  { key: 'id', label: 'Identifier', type: 'keyword', freeText: true, path: 'id' },
  { key: 'units', label: 'Units', type: 'number', path: 'units' },
]

const engine = createWorkerEngine({ fields: portableFields })
const filtered = handleRequest({ id: 1, type: 'filter', text: 'units:[100 TO 200]', records }, engine)
assert.equal(filtered.ok, true)
assert.deepEqual(filtered.ok && filtered.type === 'filter' ? filtered.matches : [], [records[0]])

// The envelope is decoded, so the type discriminant narrows the answer; the payload itself is the
// worker's own output and is read through the published type.
const parsed = handleRequest({ id: 2, type: 'parse', text: 'id:small' }, engine)
const diagnostics =
  parsed.ok && parsed.type === 'parse' ? (parsed.parsed as ParsedQuery).diagnostics.length : -1
assert.equal(diagnostics, 0)

// The protocol is decoded before the engine sees it, so a message missing a required field is
// refused at the seam rather than reaching a half-shaped call.
assert.equal(isWorkerRequest({ id: 3, type: 'filter', text: 'id:small' }), false)
assert.equal(isWorkerRequest({ id: 3, type: 'parse', text: 'id:small' }), true)

// A function accessor cannot cross a structured clone, so a worker schema refuses it outright.
let rejection = ''
try {
  createWorkerEngine({
    fields: [{ key: 'id', label: 'Identifier', type: 'keyword', read: (record: Item) => record.id }],
  })
} catch (error) {
  rejection = error instanceof Error ? error.message : ''
}
assert.match(rejection, /need a path instead of read: id/)

// Exercise the archived, self-contained default bootstrap in an actual native worker. No fixture
// worker or source symlink can hide a missing artifact, external import, or lost configuration.
const client = createQueryWorkerSearch({ fields: portableFields, unknownFields: 'error' })
try {
  assert.deepEqual(await client.filter('units:[100 TO 200]', records), [records[0]])
  assert.equal((await client.parse('unknown:value')).diagnostics[0]?.severity, 'error')
  assert.equal(await client.suggest('units:[', 7), undefined)
  assert.equal((await client.clauses('id:ready'))[0]?.text, 'id:ready')
} finally {
  client.terminate()
}
`

const core = `
import assert from 'node:assert/strict'
import { Context, Data, Effect, Result } from 'effect'
import {
  filterRecords, hasErrors, InvalidQueryError, QueryConfigurationError, QueryEngine,
  parseQuery, stringifyQuery, toQueryEngineAdapter, type SearchAdapter,
} from 'react-lucene-query/core'
import { fields, records, type Item } from './data.ts'

// Equality checks detect erased or widened declaration channels, not only assignability.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T
const creation = QueryEngine.make({ fields })
type ConfigurationFailure = Expect<Equal<Effect.Error<typeof creation>, QueryConfigurationError>>
const engine = Effect.runSync(creation)
assert.deepEqual(Effect.runSync(engine.filter('units:[100 TO 200]', records)), [records[0]])
assert.equal(hasErrors(engine.parse('units:many')), false)
assert.deepEqual(Effect.runSync(engine.filter('units:many', records)), [])
assert.equal(hasErrors(engine.parse('missing:anything')), false)
assert.deepEqual(Effect.runSync(engine.filter('missing:anything', records)), [])
const complex = '+id:/r.*/ units:[100 TO 200]^2 -id:small'
const parsed = parseQuery(complex, fields)
assert.equal(hasErrors(parsed), false)
assert.deepEqual(Effect.runSync(engine.filter(stringifyQuery(parsed.node), records)), [records[0]])
assert.deepEqual(toQueryEngineAdapter(engine).filter('units:[100 TO]', records), [])

const invalid = Effect.runSync(Effect.result(engine.compile('units:[100 TO]')))
Result.match(invalid, {
  onSuccess: () => { throw new Error('Invalid query unexpectedly compiled') },
  onFailure: error => {
    assert(error instanceof InvalidQueryError)
    assert(error.diagnostics.length > 0)
  },
})
Result.match(Effect.runSync(Effect.result(QueryEngine.make({ fields: [...fields, fields[0]!] }))), {
  onSuccess: () => { throw new Error('Invalid configuration unexpectedly accepted') },
  onFailure: error => assert(error instanceof QueryConfigurationError),
})

class BackendError extends Data.TaggedError('BackendError')<{ readonly message: string }> {}
class RecordStore extends Context.Service<RecordStore, {
  readonly records: readonly Item[]
  readonly available: boolean
}>()('package-consumer/RecordStore') {}
let calls = 0
const adapter: SearchAdapter<readonly Item[], BackendError, RecordStore> = parsed =>
  Effect.gen(function* () {
    calls += 1
    const store = yield* RecordStore
    if (!store.available) return yield* Effect.fail(new BackendError({ message: 'Unavailable' }))
    return filterRecords(parsed.node, fields, store.records)
  })
const search = engine.search('units:[100 TO 200]', adapter)
type AdapterResult = Expect<Equal<Effect.Success<typeof search>, readonly Item[]>>
type AdapterFailure = Expect<Equal<Effect.Error<typeof search>, InvalidQueryError | BackendError>>
type AdapterEnvironment = Expect<Equal<Effect.Services<typeof search>, RecordStore>>
// @ts-expect-error An adapter environment must be provided before synchronous execution.
const missingEnvironment: Effect.Effect<readonly Item[], InvalidQueryError | BackendError> = search
assert.deepEqual(
  Effect.runSync(Effect.provideService(search, RecordStore, { records, available: true })),
  [records[0]],
)
Result.match(Effect.runSync(Effect.result(Effect.provideService(
  search, RecordStore, { records, available: false },
))), {
  onSuccess: () => { throw new Error('Backend failure unexpectedly accepted') },
  onFailure: error => assert(error instanceof BackendError),
})
const previousCalls = calls
Result.match(Effect.runSync(Effect.result(Effect.provideService(
  engine.search('units:[100 TO]', adapter), RecordStore, { records, available: true },
))), {
  onSuccess: () => { throw new Error('Invalid backend query unexpectedly accepted') },
  onFailure: error => assert(error instanceof InvalidQueryError),
})
assert.equal(calls, previousCalls, 'Invalid input must not reach the adapter')
`

const outputs = `
import assert from 'node:assert/strict'
import { Result } from 'effect'
import { parseQuery, QueryTranslationError, type QueryField } from 'react-lucene-query/core'
import { fromQueryJson, toQueryJson, QueryTranslationError as JsonError } from 'react-lucene-query/query-json'
import { toPostgres, QueryTranslationError as PostgresError } from 'react-lucene-query/postgres'
import type { Item } from './data.ts'

const fields: readonly QueryField<Item>[] = [
  { key: 'id', label: 'Identifier', type: 'keyword', path: 'id' },
  { key: 'units', label: 'Units', type: 'number', path: 'units' },
]
const parsed = parseQuery('id:ready AND units:[100 TO 200]', fields)
const document = Result.getOrThrow(toQueryJson(parsed))
assert.equal(document.version, 1)
const decoded = Result.getOrThrow(fromQueryJson(JSON.parse(JSON.stringify(document)), fields))
assert.deepEqual(decoded.node, parsed.node)
const output = Result.getOrThrow(toPostgres(decoded, {
  fields,
  columns: { id: { column: 'id', type: 'text' }, units: { column: 'units', type: 'number' } },
}))
assert.deepEqual(output.params, ['ready', 100, 200])
assert(output.sql.includes('$1::text') && output.sql.includes('$3::double precision'))
assert.equal(JsonError, QueryTranslationError)
assert.equal(PostgresError, QueryTranslationError)
const rejection = toPostgres(parseQuery('id:rea*', fields), {
  fields, columns: { id: { column: 'id', type: 'text' } },
})
assert(Result.isFailure(rejection) && rejection.failure instanceof QueryTranslationError)
for (const entry of ['react-lucene-query/query-json', 'react-lucene-query/postgres']) {
  const wrapper = await Bun.file(Bun.resolveSync(entry, import.meta.dir)).text()
  assert(!wrapper.startsWith("'use client'"), 'Output entries must remain React-free')
}
`

const components = `

import { createQueryEngine, Query, type QueryEngine } from 'react-lucene-query'
import { QuerySearchField } from 'react-lucene-query/styled'
import { fields, records, type Item } from './data.ts'

export const engine: QueryEngine<Item> = createQueryEngine({ fields })
const props = { engine, records, value: 'units:[100 TO 200]', onValueChange: (_value: string) => {},
  onSubmit: (_value: string) => true }
export function PlainConsumer() {
  return <Query.Root {...props}><Query.Input aria-label="Plain query" /></Query.Root>
}
export function StyledConsumer() {
  return <QuerySearchField {...props} label="Styled query" />
}
`

const minimal = `
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import * as Public from 'react-lucene-query'
import { createQueryEngine, QueryConfigurationError, stringifyQuery } from 'react-lucene-query'
import { QueryConfigurationError as CoreConfigurationError } from 'react-lucene-query/core'
import { fields, records } from './data.ts'
import { engine, PlainConsumer, StyledConsumer } from './components.tsx'
assert.deepEqual(engine.filter('units:[100 TO 200]', records), [records[0]])
assert.deepEqual(engine.filter('units:many', records), [])
assert.equal(engine.compile('id:ready').test(records[0]!), true)
assert.equal(typeof stringifyQuery, 'function')
assert(engine.suggest('uni', 3, records)?.items.some(item => item.id === 'field:units'))
assert.equal(QueryConfigurationError, CoreConfigurationError, 'Entries must share domain errors')
assert.throws(() => createQueryEngine({ fields: [...fields, fields[0]!] }), QueryConfigurationError)
assert(!('QueryEngine' in Public), 'Main API must not expose the Effect engine value')
assert(!('toQueryEngineAdapter' in Public), 'Main API must not expose Effect setup')
const html = renderToStaticMarkup(<><PlainConsumer /><StyledConsumer /></>)
assert(html.includes('Plain query') && html.includes('Styled query') && html.includes('units:[100 TO 200]'))
`

const composed = `
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { Query } from 'react-lucene-query'
import { QuerySearchField } from 'react-lucene-query/styled'
import { QueryCodeMirror } from 'react-lucene-query/codemirror'
import { engine } from './components.tsx'
import { records } from './data.ts'

const props = { engine, records, value: 'units:[100 TO]', onValueChange: (_value: string) => {},
  onSubmit: (_value: string) => false }
const html = renderToStaticMarkup(
  <Query.Root {...props}>
    <Query.Input aria-label="Main root" />
    <QuerySearchField {...props} label="Styled child" />
    <QueryCodeMirror label="CodeMirror child" data-package-context="shared" />
    <Query.Diagnostics />
  </Query.Root>,
)
assert(html.includes('Main root') && html.includes('Styled child'))
assert(html.includes('data-package-context="shared"'), 'CodeMirror must consume the main root context')
assert(html.includes('aria-invalid="true"'), 'Shared context must preserve validation state')
`

const bundle = `
import assert from 'node:assert/strict'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'

const name = process.argv[2]
assert(name, 'Bundle entry is required')
const installed = await realpath(join(import.meta.dir, 'node_modules', 'react-lucene-query'))
const headless = name === 'core.ts' || name === 'outputs.ts'
for (const entry of ['react-lucene-query/core', 'react-lucene-query/worker', 'react-lucene-query/query-json', 'react-lucene-query/postgres', ...(headless ? [] : ['react-lucene-query', 'react-lucene-query/styled'])]) {
  const resolved = await realpath(Bun.resolveSync(entry, import.meta.dir))
  assert(resolved.startsWith(installed + '/dist/'), 'Entry must resolve from the installed archive: ' + resolved)
}
const result = await Bun.build({
  entrypoints: [join(import.meta.dir, name)],
  target: headless ? 'bun' : 'browser',
  outdir: join(import.meta.dir, 'bundled', name),
  packages: 'bundle',
})
if (!result.success) throw new AggregateError(result.logs, 'Packed consumer bundle failed')
assert(result.outputs.length > 0)
`

try {
  await mkdir(consumer)
  await run(repository, process.execPath, 'pm', 'pack', '--ignore-scripts', '--filename', archive)
  assert(await Bun.file(archive).exists(), 'Package archive was not created')
  await Promise.all([
    writeConsumerFile('data.ts', data),
    writeConsumerFile('core.ts', core),
    writeConsumerFile('worker.ts', worker),
    writeConsumerFile('outputs.ts', outputs),
    writeConsumerFile('components.tsx', components),
    writeConsumerFile('minimal.tsx', minimal),
    writeConsumerFile('composed.tsx', composed),
    writeConsumerFile('bundle.ts', bundle),
    writeConsumerFile('styles.ts', "import 'react-lucene-query/styles.css'\n"),
  ])

  await install({})
  await assertAbsent(['react', 'react-dom', ...Object.keys(codemirror)])
  await checkTypes(['data.ts', 'core.ts', 'worker.ts', 'outputs.ts'])
  await run(consumer, process.execPath, 'run', 'core.ts')
  await run(consumer, process.execPath, 'run', 'worker.ts')
  await run(consumer, process.execPath, 'run', 'bundle.ts', 'core.ts')
  await run(consumer, process.execPath, 'run', 'outputs.ts')
  await run(consumer, process.execPath, 'run', 'bundle.ts', 'outputs.ts')

  await install(react)
  await assertAbsent(Object.keys(codemirror))
  await checkTypes(['data.ts', 'core.ts', 'minimal.tsx'])
  await run(consumer, process.execPath, 'run', 'minimal.tsx')
  await run(consumer, process.execPath, 'run', 'bundle.ts', 'components.tsx')
  await run(consumer, process.execPath, 'run', 'bundle.ts', 'styles.ts')

  await install({ ...react, ...codemirror })
  await checkTypes(['data.ts', 'core.ts', 'minimal.tsx', 'composed.tsx'])
  await run(consumer, process.execPath, 'run', 'composed.tsx')

  console.log('Packed consumer declarations, runtime, shared context, and isolated bundles passed.')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
