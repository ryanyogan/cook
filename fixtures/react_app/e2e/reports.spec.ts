import { createTask, expect, test, uid, visit } from './fixtures'

test('report for an account with no tasks is all zeroes', async ({ page, account }) => {
  void account
  await visit(page, '/reports')
  await page.getByRole('button', { name: 'Build report' }).click()

  await expect(page.getByTestId('report-total')).toHaveText('0')
  await expect(page.getByTestId('report-open')).toHaveText('0')
})

// Slow on purpose: the server aggregates task by task, so 12 tasks take about 1.8 s.
test('report over a large backlog adds up by status and priority', { tag: '@slow' }, async ({ page, account }) => {
  void account
  const priorities = ['low', 'normal', 'high', 'high']
  for (let i = 0; i < 12; i++) await createTask(page, `Backlog ${i} ${uid()}`, priorities[i % 4])

  await visit(page, '/tasks')
  const boxes = page.getByRole('checkbox')
  await expect(boxes).toHaveCount(12)
  for (let i = 0; i < 3; i++) {
    await boxes.nth(i).check()
    await expect(boxes.nth(i)).toBeChecked()
  }

  await page.getByRole('link', { name: 'Reports' }).click()
  await page.getByRole('button', { name: 'Build report' }).click()
  await expect(page.getByRole('status')).toHaveText('Building report…')

  await expect(page.getByTestId('report-total')).toHaveText('12')
  await expect(page.getByTestId('report-done')).toHaveText('3')
  await expect(page.getByTestId('report-open')).toHaveText('9')
  await expect(page.getByTestId('report-low')).toHaveText('3')
  await expect(page.getByTestId('report-normal')).toHaveText('3')
  await expect(page.getByTestId('report-high')).toHaveText('6')
})
