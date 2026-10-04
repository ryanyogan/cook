import { createTask, expect, taskItem, test, uid, visit } from './fixtures'

test('deletes a task after confirmation and leaves the others', async ({ page, account }) => {
  void account
  const doomed = await createTask(page, `Delete me ${uid()}`)
  const kept = await createTask(page, `Keep me ${uid()}`)

  await visit(page, `/tasks/${doomed.id}`)
  await page.getByRole('button', { name: 'Delete task' }).click()
  await page.getByRole('button', { name: 'Confirm delete' }).click()

  await expect(page).toHaveURL(/\/tasks$/)
  await expect(taskItem(page, kept.title)).toBeVisible()
  await expect(taskItem(page, doomed.title)).toHaveCount(0)
  await expect(page.getByTestId('task-count')).toHaveText('1 task')
})

test('backing out of the confirmation keeps the task', async ({ page, account }) => {
  void account
  const task = await createTask(page, `Second thoughts ${uid()}`)

  await visit(page, `/tasks/${task.id}`)
  await page.getByRole('button', { name: 'Delete task' }).click()
  await page.getByRole('button', { name: 'Keep it' }).click()
  await expect(page.getByRole('button', { name: 'Delete task' })).toBeVisible()

  await page.getByRole('link', { name: 'Back to tasks' }).click()
  await expect(taskItem(page, task.title)).toBeVisible()
})

