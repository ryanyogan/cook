import { expect, taskItem, test, uid, visit } from './fixtures'

test('imports one task per line', async ({ page, account }) => {
  void account
  const titles = [`Imported A ${uid()}`, `Imported B ${uid()}`]
  await visit(page, '/import')
  await page.getByLabel('Tasks to import').fill(titles.join('\n'))
  await page.getByRole('button', { name: 'Import' }).click()

  await expect(page.getByTestId('import-result')).toContainText('Imported 2 tasks')
  await page.getByRole('link', { name: 'View tasks' }).click()
  for (const title of titles) await expect(taskItem(page, title)).toBeVisible()
})

test('reads a priority after the bar and skips lines that fail validation', async ({ page, account }) => {
  void account
  const good = `Urgent thing ${uid()}`
  await visit(page, '/import')
  await page.getByLabel('Tasks to import').fill(`${good} | high\nab\nBad priority ${uid()} | someday`)
  await page.getByRole('button', { name: 'Import' }).click()

  const result = page.getByTestId('import-result')
  await expect(result).toContainText('Imported 1 task')
  await expect(result).toContainText('Skipped 2:')
  await expect(result.getByRole('list', { name: 'Skipped lines' }).getByRole('listitem')).toHaveCount(2)

  await result.getByRole('link', { name: 'View tasks' }).click()
  await expect(taskItem(page, good)).toContainText('high')
})

// Slow on purpose: the server handles lines one at a time, so 20 lines take about 2 s.
test('imports a long list and every line arrives', { tag: '@slow' }, async ({ page, account }) => {
  void account
  const batch = uid()
  const titles = Array.from({ length: 20 }, (_, i) => `Bulk ${batch} item ${String(i + 1).padStart(2, '0')}`)
  await visit(page, '/import')
  await page.getByLabel('Tasks to import').fill(titles.join('\n'))
  await page.getByRole('button', { name: 'Import' }).click()

  await expect(page.getByRole('status')).toHaveText('Importing…')
  await expect(page.getByTestId('import-result')).toContainText('Imported 20 tasks')

  await page.getByRole('link', { name: 'View tasks' }).click()
  await expect(page.getByTestId('task-count')).toHaveText('20 tasks')
  await page.getByLabel('Search tasks').fill(`${batch} item 1`)
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page.getByTestId('task-count')).toHaveText('10 tasks')
})
