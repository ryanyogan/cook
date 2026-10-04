import { expect, taskItem, test, uid, visit } from './fixtures'

test.beforeEach(async ({ page, account }) => {
  void account
  await visit(page, '/tasks/new')
})

test('creates a task and shows it in the list', async ({ page }) => {
  const title = `Water the plants ${uid()}`
  await page.getByLabel('Title').fill(title)
  await page.getByRole('button', { name: 'Create task' }).click()

  await expect(page).toHaveURL(/\/tasks$/)
  await expect(taskItem(page, title)).toBeVisible()
  await expect(page.getByTestId('task-count')).toHaveText('1 task')
})

test('keeps the chosen priority and notes', async ({ page }) => {
  const title = `Renew passport ${uid()}`
  const notes = `Bring two photos ${uid()}`
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('Priority').selectOption('high')
  await page.getByLabel('Notes').fill(notes)
  await page.getByRole('button', { name: 'Create task' }).click()

  await expect(taskItem(page, title)).toContainText('high')
  await page.getByRole('link', { name: title }).click()
  await expect(page.getByTestId('priority')).toHaveText('high')
  await expect(page.getByTestId('notes')).toHaveText(notes)
})

test('requires a title', async ({ page }) => {
  await page.getByRole('button', { name: 'Create task' }).click()
  await expect(page.getByText('Title is required')).toBeVisible()
  await expect(page).toHaveURL(/\/tasks\/new$/)
})

test('rejects a title shorter than three characters', async ({ page }) => {
  await page.getByLabel('Title').fill('ab')
  await page.getByRole('button', { name: 'Create task' }).click()
  await expect(page.getByText('Title must be at least 3 characters')).toBeVisible()
})

test('rejects notes longer than 200 characters and keeps what was typed', async ({ page }) => {
  const title = `Long notes ${uid()}`
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('Notes').fill('x'.repeat(201))
  await page.getByRole('button', { name: 'Create task' }).click()

  await expect(page.getByText('Notes must be 200 characters or fewer')).toBeVisible()
  await expect(page.getByLabel('Title')).toHaveValue(title)
})

