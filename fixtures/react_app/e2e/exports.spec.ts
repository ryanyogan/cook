import { createTask, expect, test, uid, visit } from './fixtures'

test('an export is queued at once and finishes in the background', async ({ page, account }) => {
  void account
  await createTask(page, `Exported ${uid()}`)
  await visit(page, '/exports')
  await expect(page.getByText('No exports yet.')).toBeVisible()

  await page.getByRole('button', { name: 'Start export' }).click()

  const job = page.getByRole('list', { name: 'Exports' }).getByRole('listitem')
  await expect(job).toHaveCount(1)
  await expect(job).toContainText('queued')
  await expect(job).toContainText('done, 1 task')
  await expect(job).toHaveAttribute('data-status', 'done')
})

test('a finished export reports how many tasks it covered', async ({ page, account }) => {
  void account
  for (const name of ['One', 'Two', 'Three']) await createTask(page, `${name} ${uid()}`)
  await visit(page, '/exports')

  await page.getByRole('button', { name: 'Start export' }).click()

  await expect(page.getByRole('list', { name: 'Exports' }).getByRole('listitem')).toContainText('done, 3 tasks')
})

test('a finished export is still listed after a reload and logged as activity', async ({ page, account }) => {
  void account
  await visit(page, '/exports')
  await page.getByRole('button', { name: 'Start export' }).click()
  const job = page.getByRole('list', { name: 'Exports' }).getByRole('listitem')
  await expect(job).toContainText('done, 0 tasks')
  const label = (await job.innerText()).split(':')[0]

  await page.reload()
  await expect(page.getByRole('list', { name: 'Exports' }).getByRole('listitem')).toContainText('done, 0 tasks')

  await page.getByRole('link', { name: 'Activity' }).click()
  await expect(page.getByText(`${label} finished`)).toBeVisible()
})
