import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

let temporary: string

let clientModule: string

let workerModule: string

test.beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'query-browser-worker-'))
  const bundle = join(temporary, 'client.js')

  execFileSync('bun', ['build', 'dist/worker.js', '--target=browser', '--outfile', bundle])
  clientModule = await readFile(bundle, 'utf8')
  workerModule = await readFile('dist/worker-entry.js', 'utf8')
})

test.afterAll(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true })
})

test.beforeEach(async ({ context, page }) => {
  const resources = new Map([
    ['/worker-test/client.js', clientModule],
    ['/worker-test/worker-entry.js', workerModule],
  ])

  await context.route('**/worker-test/**', (route) => {
    const body = resources.get(new URL(route.request().url()).pathname)

    return route.fulfill({
      status: body === undefined ? 404 : 200,
      contentType: 'application/javascript',
      body: body ?? '',
    })
  })
  await page.goto('/')
})

test('default module worker receives its schema and answers every public operation', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const url = '/worker-test/client.js'
    const module = await import(url)

    const client = module.createQueryWorkerSearch({
      fields: [
        {
          key: 'id',
          label: 'Identifier',
          type: 'keyword',
          path: 'id',
          freeText: true,
          options: ['ready', 'small'],
        },
        { key: 'units', label: 'Units', type: 'number', path: 'units' },
      ],
      unknownFields: 'error',
    })

    try {
      return {
        filtered: await client.filter('units:[100 TO 200]', [
          { id: 'ready', units: 120 },
          { id: 'small', units: 5 },
        ]),
        bare: await client.filter('ready', [{ id: 'ready' }, { id: 'small' }]),
        parsed: await client.parse('unknown:value'),
        none: (await client.suggest('units:[', 7)) === undefined,
        suggestions: await client.suggest('id:', 3),
        clauses: await client.clauses('id:ready'),
      }
    } finally {
      client.terminate()
    }
  })

  expect(result.filtered).toEqual([{ id: 'ready', units: 120 }])
  expect(result.bare).toEqual([{ id: 'ready' }])
  expect(result.parsed.diagnostics).toMatchObject([{ severity: 'error' }])
  expect(result.none).toBe(true)
  expect(result.suggestions.items).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: 'ready' })]),
  )
  expect(result.clauses).toMatchObject([{ text: 'id:ready' }])
})

test('module load failure rejects both pending and later calls', async ({ page }) => {
  const errors = await page.evaluate(async () => {
    const url = '/worker-test/client.js'
    const module = await import(url)

    const client = module.createQueryWorkerSearch({
      fields: [],
      workerUrl: '/worker-test/missing.js',
    })

    const errors: string[] = []

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await client.parse('')
        } catch (error) {
          errors.push(String(error))
        }
      }

      return errors
    } finally {
      client.terminate()
    }
  })

  expect(errors).toHaveLength(2)
  expect(errors[0]).toMatch(/failed to load or execute/)
  expect(errors[1]).toBe(errors[0])
})

test('invalid default initialization rejects a query rather than leaving it pending', async ({
  page,
}) => {
  const error = await page.evaluate(async () => {
    const url = '/worker-test/client.js'
    const module = await import(url)

    const client = module.createQueryWorkerSearch({
      fields: [{ key: 'id', label: 'Id', type: 'keyword', path: '' }],
    })

    try {
      await client.filter('', [])

      return ''
    } catch (error) {
      return String(error)
    } finally {
      client.terminate()
    }
  })

  expect(error).toContain('exactly one')
})
