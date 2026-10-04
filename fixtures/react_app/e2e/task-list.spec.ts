import { createTask, expect, taskItem, test, uid, visit } from './fixtures'

test('a new account starts with an empty list', async ({ page, account }) => {
  void account
  await visit(page, '/tasks')
  await expect(page.getByText('No tasks yet. Create your first one.')).toBeVisible()
  await expect(page.getByTestId('task-count')).toHaveText('0 tasks')
})

test('lists the newest task first', async ({ page, account }) => {
  void account
  const first = await createTask(page, `First ${uid()}`)
  const second = await createTask(page, `Second ${uid()}`)

  await visit(page, '/tasks')
  const items = page.getByRole('list', { name: 'Tasks' }).getByRole('listitem')
  await expect(items).toHaveCount(2)
  await expect(items.nth(0)).toContainText(second.title)
  await expect(items.nth(1)).toContainText(first.title)
})

test('search narrows the list to matching titles', async ({ page, account }) => {
  void account
  const needle = `needle${uid()}`
  const match = await createTask(page, `Buy ${needle} today`)
  const other = await createTask(page, `Unrelated ${uid()}`)

  await visit(page, '/tasks')
  await page.getByLabel('Search tasks').fill(needle)
  await page.getByRole('button', { name: 'Search', exact: true }).click()

  await expect(page).toHaveURL(new RegExp(`q=${needle}`))
  await expect(taskItem(page, match.title)).toBeVisible()
  await expect(taskItem(page, other.title)).toHaveCount(0)
  await expect(page.getByTestId('task-count')).toHaveText('1 task')
})

test('search with no matches says so', async ({ page, account }) => {
  void account
  await createTask(page, `Something ${uid()}`)

  await visit(page, '/tasks')
  await page.getByLabel('Search tasks').fill(`nothing-${uid()}`)
  await page.getByLabel('Search tasks').press('Enter')

  await expect(page.getByText('No tasks match your filters.')).toBeVisible()
})

test('a search in the address bar survives a reload', async ({ page, account }) => {
  void account
  const needle = `sticky${uid()}`
  const match = await createTask(page, `Remember ${needle}`)
  const other = await createTask(page, `Forget ${uid()}`)

  await visit(page, `/tasks?q=${needle}`)
  await expect(page.getByLabel('Search tasks')).toHaveValue(needle)
  await expect(taskItem(page, match.title)).toBeVisible()
  await expect(taskItem(page, other.title)).toHaveCount(0)
})

test('ticking a task marks it done', async ({ page, account }) => {
  void account
  const task = await createTask(page, `Tick me ${uid()}`)

  await visit(page, '/tasks')
  const checkbox = page.getByRole('checkbox', { name: `Mark "${task.title}" done` })
  await checkbox.check()
  await expect(checkbox).toBeChecked()

  await page.reload()
  await expect(page.getByRole('checkbox', { name: `Mark "${task.title}" done` })).toBeChecked()
})

test('status filter separates open from done', async ({ page, account }) => {
  void account
  const open = await createTask(page, `Still open ${uid()}`)
  const done = await createTask(page, `Already done ${uid()}`)

  await visit(page, '/tasks')
  await page.getByRole('checkbox', { name: `Mark "${done.title}" done` }).check()
  await expect(page.getByRole('checkbox', { name: `Mark "${done.title}" done` })).toBeChecked()

  await page.getByLabel('Show').selectOption('done')
  await expect(taskItem(page, done.title)).toBeVisible()
  await expect(taskItem(page, open.title)).toHaveCount(0)

  await page.getByLabel('Show').selectOption('open')
  await expect(taskItem(page, open.title)).toBeVisible()
  await expect(taskItem(page, done.title)).toHaveCount(0)
})

