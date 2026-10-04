import { createTask, expect, taskItem, test, uid, visit } from './fixtures'

test('renames a task', async ({ page, account }) => {
  void account
  const task = await createTask(page, `Draft ${uid()}`)
  const renamed = `Final ${uid()}`

  await visit(page, `/tasks/${task.id}`)
  await page.getByRole('link', { name: 'Edit task' }).click()
  await expect(page.getByLabel('Title')).toHaveValue(task.title)
  await page.getByLabel('Title').fill(renamed)
  await page.getByRole('button', { name: 'Save changes' }).click()

  await expect(page.getByRole('heading', { name: renamed })).toBeVisible()
  await page.getByRole('link', { name: 'Back to tasks' }).click()
  await expect(taskItem(page, renamed)).toBeVisible()
  await expect(taskItem(page, task.title)).toHaveCount(0)
})

test('changes the priority', async ({ page, account }) => {
  void account
  const task = await createTask(page, `Reprioritise ${uid()}`, 'low')

  await visit(page, `/tasks/${task.id}/edit`)
  await page.getByLabel('Priority').selectOption('high')
  await page.getByRole('button', { name: 'Save changes' }).click()

  await expect(page.getByTestId('priority')).toHaveText('high')
})

test('shows a validation error and leaves the task unchanged', async ({ page, account }) => {
  void account
  const task = await createTask(page, `Stay as I am ${uid()}`)

  await visit(page, `/tasks/${task.id}/edit`)
  await page.getByLabel('Title').fill('')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Title is required')).toBeVisible()

  await visit(page, `/tasks/${task.id}`)
  await expect(page.getByRole('heading', { name: task.title })).toBeVisible()
})

test('another user cannot open the task', async ({ page, account, browser }) => {
  void account
  const task = await createTask(page, `Private ${uid()}`)

  const stranger = await browser.newContext()
  const strangerPage = await stranger.newPage()
  const signedUp = await strangerPage.request.post('/api/signup', {
    data: { name: 'Stranger', email: `stranger-${uid()}@example.test`, password: 'stranger-password' },
  })
  expect(signedUp.status()).toBe(201)
  await visit(strangerPage, `/tasks/${task.id}`)
  await expect(strangerPage.getByRole('heading', { name: 'Task not found' })).toBeVisible()
  await stranger.close()
})
