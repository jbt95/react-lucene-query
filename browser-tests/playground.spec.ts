import { expect, test, type Locator, type Page } from '@playwright/test'

const allShipments = ['SHP-1042', 'SHP-1043', 'SHP-1044', 'SHP-1045']

const readyQuery = 'status:ready AND units:[100 TO 200]'

const carrierQuery = 'carrier:"North Star"'

const presentations = ['Styled field', 'Headless', 'CodeMirror'] as const

type Presentation = (typeof presentations)[number]

async function openEditor(page: Page, presentation: Presentation) {
  await page.getByRole('button', { name: presentation, exact: true }).click()

  const editor =
    presentation === 'CodeMirror'
      ? page.getByRole('textbox', { name: 'Query', exact: true })
      : page.getByRole('combobox', {
          name: presentation === 'Headless' ? 'Your own input, no library styles' : 'Query',
          exact: true,
        })

  await expect(editor).toBeVisible()

  return editor
}

async function expectDraft(editor: Locator, presentation: Presentation, value: string) {
  if (presentation === 'CodeMirror') {
    if (value) await expect(editor).toHaveText(value)
    else await expect(editor.locator('.cm-placeholder')).toBeVisible()
  } else await expect(editor).toHaveValue(value)
}

async function expectResults(page: Page, ids: readonly string[], applied: string) {
  const results = page.getByRole('region', { name: 'Matching shipments', exact: true })
  await expect(results.getByRole('rowheader')).toHaveText([...ids])
  await expect(results.locator('output')).toHaveText(`${ids.length} of ${allShipments.length}`)
  await expect(results.locator('.applied code')).toHaveText(applied || '(all shipments)')
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expectResults(page, allShipments, '')
})

for (const presentation of presentations) {
  test(`${presentation}: applies valid drafts, preserves invalid drafts, and clears`, async ({
    page,
  }) => {
    const editor = await openEditor(page, presentation)
    await editor.fill(readyQuery)
    await expectResults(page, allShipments, '')
    await editor.press('Escape')
    await editor.press('Enter')
    await expectResults(page, ['SHP-1042'], readyQuery)

    await editor.fill('units:[100 TO]')
    await expect(editor).toHaveAttribute('aria-invalid', 'true')
    await expectResults(page, ['SHP-1042'], readyQuery)
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expectDraft(editor, presentation, 'units:[100 TO]')
    await expectResults(page, ['SHP-1042'], readyQuery)
    await expect(page.locator('.workbench [data-severity="error"]').first()).toBeVisible()

    await page.getByRole('button', { name: 'Clear', exact: true }).click()
    await expectDraft(editor, presentation, '')
    await expect(editor).toHaveAttribute('aria-invalid', 'false')
    await expectResults(page, allShipments, '')
    await expect(page.locator('.workbench [data-severity="error"]')).toHaveCount(0)
  })

  test(`${presentation}: synchronizes preset changes and presentation changes`, async ({
    page,
  }) => {
    let editor = await openEditor(page, presentation)
    await editor.fill('units:[100 TO]')
    await page.getByRole('button', { name: carrierQuery, exact: true }).click()
    await expectDraft(editor, presentation, carrierQuery)
    await expect(editor).toHaveAttribute('aria-invalid', 'false')
    await expectResults(page, ['SHP-1042', 'SHP-1044'], carrierQuery)

    const otherPresentation = presentation === 'Headless' ? 'Styled field' : 'Headless'
    const otherEditor = await openEditor(page, otherPresentation)
    await expectDraft(otherEditor, otherPresentation, carrierQuery)
    await otherEditor.fill('status:delayed')
    editor = await openEditor(page, presentation)
    await expectDraft(editor, presentation, 'status:delayed')
    await expectResults(page, ['SHP-1042', 'SHP-1044'], carrierQuery)
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expectResults(page, ['SHP-1043'], 'status:delayed')
  })
}

test('the playground filters with phrases, wildcards, regex, fuzzy terms, ranges, and prohibition', async ({
  page,
}) => {
  const editor = await openEditor(page, 'Styled field')

  const cases: readonly (readonly [string, readonly string[]])[] = [
    ['carrier:"north star"', ['SHP-1042', 'SHP-1044']],
    ['carrier:north*', ['SHP-1042', 'SHP-1044']],
    ['carrier:/arc|atlas/', ['SHP-1043', 'SHP-1045']],
    ['carrier:arx~1', ['SHP-1043']],
    ['units:[120 TO 450]', ['SHP-1042', 'SHP-1043', 'SHP-1044']],
    ['units:[35 TO 75]', ['SHP-1043', 'SHP-1044', 'SHP-1045']],
    ['units:{120 TO 450}', ['SHP-1043']],
    ['status:(ready OR delayed)', ['SHP-1042', 'SHP-1043', 'SHP-1045']],
    ['*:* AND NOT status:delivered', ['SHP-1042', 'SHP-1043', 'SHP-1045']],
  ]

  for (const [query, expected] of cases) {
    // Clearing first keeps each draft a replacement rather than an append into the mirror.
    await editor.fill('')
    await expect(editor).toHaveValue('')
    await editor.fill(query)
    await expect(editor).toHaveValue(query)
    await editor.press('Enter')
    await expectResults(page, expected, query)
    await expect(editor).toHaveAttribute('aria-invalid', 'false')
  }
})

test('CodeMirror completes fields and values with keyboard commands without premature filtering', async ({
  page,
}) => {
  const editor = await openEditor(page, 'CodeMirror')
  await editor.fill('carr')
  await editor.press('Control+Space')
  await expect(
    page.getByRole('option').filter({
      has: page.locator('.cm-completionLabel', { hasText: /^carrier$/ }),
    }),
  ).toBeVisible()
  await editor.press('Tab')
  await expectDraft(editor, 'CodeMirror', 'carrier:')
  await expectResults(page, allShipments, '')

  await editor.fill('status:rea')
  await editor.press('Control+Space')
  await expect(
    page.getByRole('option').filter({
      has: page.locator('.cm-completionLabel', { hasText: /^ready$/ }),
    }),
  ).toBeVisible()
  await editor.press('Enter')
  await expectDraft(editor, 'CodeMirror', 'status:ready ')
  await expectResults(page, allShipments, '')
  await editor.press('Enter')
  await expectResults(page, ['SHP-1042', 'SHP-1045'], 'status:ready ')
})

test('CodeMirror navigates an empty-query completion list and accepts the selected field', async ({
  page,
}) => {
  const editor = await openEditor(page, 'CodeMirror')
  await editor.focus()
  await editor.press('Control+Space')
  await expect(page.getByRole('listbox')).toBeVisible()
  await editor.press('ArrowDown')
  const selected = page.getByRole('option', { selected: true })
  await expect(selected).toBeVisible()
  const label = await selected.locator('.cm-completionLabel').innerText()
  await editor.press('Enter')
  await expectDraft(editor, 'CodeMirror', `${label}:`)
  await expectResults(page, allShipments, '')
})

test('CodeMirror dismisses and reopens completion while preserving the draft', async ({ page }) => {
  const editor = await openEditor(page, 'CodeMirror')
  await editor.fill('carr')
  await editor.press('Control+Space')
  await expect(page.getByRole('listbox')).toBeVisible()
  await editor.press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expectDraft(editor, 'CodeMirror', 'carr')
  await editor.press('Control+Space')
  await expect(
    page.getByRole('option').filter({
      has: page.locator('.cm-completionLabel', { hasText: /^carrier$/ }),
    }),
  ).toBeVisible()
  await editor.press('Tab')
  await expectDraft(editor, 'CodeMirror', 'carrier:')
})

for (const presentation of ['Styled field', 'Headless'] as const) {
  test(`${presentation}: exposes keyboard completion and keeps focus on its input`, async ({
    page,
  }) => {
    const editor = await openEditor(page, presentation)
    await editor.fill('status:rea')
    await expect(editor).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('option', { name: /^ready\b/ })).toBeVisible()
    await editor.press('Escape')
    await expect(editor).toHaveAttribute('aria-expanded', 'false')
    await editor.press('Control+Space')
    await expect(editor).toHaveAttribute('aria-expanded', 'true')
    await editor.press('ArrowDown')
    const selected = page.getByRole('option', { selected: true })
    await expect(selected).toBeVisible()
    const selectedId = await selected.getAttribute('id')

    if (!selectedId) throw new Error('Missing selected completion identifier')
    await expect(editor).toHaveAttribute('aria-activedescendant', selectedId)
    await editor.press('Tab')
    await expect(editor).toBeFocused()
    await expectDraft(editor, presentation, 'status:ready ')
    await expectResults(page, allShipments, '')
    await editor.press('Enter')
    await expectResults(page, ['SHP-1042', 'SHP-1045'], 'status:ready ')
  })
}

test('styled mirror retains the textarea metrics and bounds when a long query wraps', async ({
  page,
}) => {
  const editor = await openEditor(page, 'Styled field')
  const mirror = page.locator('.rlq-highlight[aria-hidden="true"]')
  const initialBounds = await editor.boundingBox()
  expect(initialBounds).not.toBeNull()

  if (!initialBounds) throw new Error('Missing initial textarea bounds')

  const query = `carrier:"${'North Star '.repeat(32).trim()}" AND status:ready AND units:[100 TO 200]`
  await editor.fill(query)
  await expect(mirror).toHaveText(`${query}\u200b`)

  const metrics = (element: Element) => {
    const style = getComputedStyle(element)
    const bounds = element.getBoundingClientRect()

    return {
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      text: [
        style.fontFamily,
        style.fontSize,
        style.fontWeight,
        style.fontStyle,
        style.lineHeight,
        style.letterSpacing,
        style.whiteSpace,
        style.overflowWrap,
        style.paddingTop,
        style.paddingRight,
        style.paddingBottom,
        style.paddingLeft,
        style.boxSizing,
      ],
    }
  }

  const inputMetrics = await editor.evaluate(metrics)
  const mirrorMetrics = await mirror.evaluate(metrics)
  expect(inputMetrics.text).toEqual(mirrorMetrics.text)
  expect(inputMetrics.bounds.x).toBeCloseTo(mirrorMetrics.bounds.x, 1)
  expect(inputMetrics.bounds.y).toBeCloseTo(mirrorMetrics.bounds.y, 1)
  expect(inputMetrics.bounds.width).toBeCloseTo(mirrorMetrics.bounds.width, 1)
  expect(inputMetrics.bounds.height).toBeCloseTo(mirrorMetrics.bounds.height, 1)
  expect(inputMetrics.bounds.height).toBeGreaterThan(initialBounds.height)
  const overflow = await editor.evaluate((element) => element.scrollHeight - element.clientHeight)
  expect(overflow).toBeLessThanOrEqual(1)

  const viewport = page.viewportSize()

  if (!viewport) throw new Error('Missing viewport')
  expect(inputMetrics.bounds.x).toBeGreaterThanOrEqual(0)
  expect(inputMetrics.bounds.x + inputMetrics.bounds.width).toBeLessThanOrEqual(viewport.width)
  const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(documentWidth).toBeLessThanOrEqual(viewport.width)
})

for (const presentation of ['Styled field', 'CodeMirror'] as const) {
  test(`${presentation}: keyboard focus and text selection remain usable in forced colors`, async ({
    page,
  }) => {
    const editor = await openEditor(page, presentation)
    await editor.fill(carrierQuery)
    await editor.press('Escape')
    await editor.press('Tab')
    const search = page.getByRole('button', { name: 'Search', exact: true })
    await expect(search).toBeFocused()

    const focus = await search.evaluate((element) => {
      const style = getComputedStyle(element)

      return {
        visible: element.matches(':focus-visible'),
        style: style.outlineStyle,
        width: style.outlineWidth,
      }
    })

    expect(focus.visible).toBe(true)
    expect(focus.style).not.toBe('none')
    expect(Number.parseFloat(focus.width)).toBeGreaterThan(0)
    await page.keyboard.press('Shift+Tab')
    await expect(editor).toBeFocused()
    await expect(editor).toBeVisible()

    const focusSurface =
      presentation === 'CodeMirror' ? page.locator('.cm-editor') : editor.locator('..')

    await expect
      .poll(() =>
        focusSurface.evaluate((element) => {
          const style = getComputedStyle(element)

          return (
            style.outlineStyle !== 'none' &&
            style.outlineStyle !== 'hidden' &&
            Number.parseFloat(style.outlineWidth) > 0
          )
        }),
      )
      .toBe(true)
    await editor.press('ControlOrMeta+A')

    const selectedText = await editor.evaluate((element) => {
      if (element instanceof HTMLTextAreaElement) {
        return element.value.slice(element.selectionStart, element.selectionEnd)
      }

      return window.getSelection()?.toString() ?? ''
    })

    expect(selectedText).toBe(carrierQuery)
    await page.keyboard.insertText('status:delayed')
    await expectDraft(editor, presentation, 'status:delayed')
    await editor.press('Escape')
    await editor.press('Enter')
    await expectResults(page, ['SHP-1043'], 'status:delayed')

    const forcedColors = await page.evaluate(() => matchMedia('(forced-colors: active)').matches)

    if (forcedColors && presentation === 'Styled field') {
      await expect(page.locator('.rlq-highlight[aria-hidden="true"]')).toBeHidden()
      const color = await editor.evaluate((element) => getComputedStyle(element).color)
      expect(color).not.toBe('rgba(0, 0, 0, 0)')
    }
  })
}
