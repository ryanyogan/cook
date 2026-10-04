import { createTask, expect, test, uid, visit } from './fixtures'

const feed = (page: import('@playwright/test').Page) => page.getByRole('list', { name: 'Activity feed' })

test('a new account has no activity', async ({ page, account }) => {
  void account
  await visit(page, '/activity')
  await expect(page.getByText('Nothing has happened yet.')).toBeVisible()
})

test('shows a task created elsewhere without a reload', async ({ page, account }) => {
  void account
  await visit(page, '/activity')
  await expect(page.getByText('Nothing has happened yet.')).toBeVisible()

  const task = await createTask(page, `From the API ${uid()}`)

  await expect(feed(page).getByText(`Created "${task.title}"`)).toBeVisible()
  await expect(page.getByText('Nothing has happened yet.')).toHaveCount(0)
})

test('follows work done in a second tab', async ({ page, account, context }) => {
  void account
  const task = await createTask(page, `Two tabs ${uid()}`)
  await visit(page, '/activity')
  await expect(feed(page).getByRole('listitem')).toHaveCount(1)

  const second = await context.newPage()
  await visit(second, '/tasks')
  await second.getByRole('checkbox', { name: `Mark "${task.title}" done` }).check()

  await expect(feed(page).getByText(`Completed "${task.title}"`)).toBeVisible()
  await expect(feed(page).getByRole('listitem')).toHaveCount(2)
})

test('puts the most recent event at the top', async ({ page, account }) => {
  void account
  await visit(page, '/activity')
  const first = await createTask(page, `Earlier ${uid()}`)
  await expect(feed(page).getByText(`Created "${first.title}"`)).toBeVisible()
  const second = await createTask(page, `Later ${uid()}`)

  await expect(feed(page).getByRole('listitem')).toHaveCount(2)
  await expect(feed(page).getByRole('listitem').first()).toHaveText(`Created "${second.title}"`)
})
