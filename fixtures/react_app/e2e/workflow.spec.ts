import { expect, newAccount, taskItem, test, uid, visit } from './fixtures'

// Slow on purpose: a whole week of use, entirely through the interface.
test('a new user works through a full week of tasks', { tag: '@slow' }, async ({ page }) => {
  const account = newAccount()
  const batch = uid()
  const titles = ['Plan sprint', 'Write spec', 'Review design', 'Fix login bug', 'Send notes'].map(
    (t) => `${t} ${batch}`,
  )

  await visit(page, '/signup')
  await page.getByLabel('Name').fill(account.name)
  await page.getByLabel('Email').fill(account.email)
  await page.getByLabel('Password').fill(account.password)
  await page.getByRole('button', { name: 'Sign up' }).click()
  await expect(page.getByTestId('current-user')).toContainText(account.name)

  for (const [i, title] of titles.entries()) {
    await page.getByRole('link', { name: 'New task' }).click()
    await page.getByLabel('Title').fill(title)
    await page.getByLabel('Priority').selectOption(i % 2 === 0 ? 'high' : 'low')
    await page.getByLabel('Notes').fill(`Step ${i + 1} of the week`)
    await page.getByRole('button', { name: 'Create task' }).click()
    await expect(taskItem(page, title)).toBeVisible()
  }
  await expect(page.getByTestId('task-count')).toHaveText('5 tasks')

  for (const title of titles.slice(0, 3)) {
    const box = page.getByRole('checkbox', { name: `Mark "${title}" done` })
    await box.check()
    await expect(box).toBeChecked()
  }

  await page.getByLabel('Show').selectOption('open')
  await expect(page.getByTestId('task-count')).toHaveText('2 tasks')
  await page.getByLabel('Show').selectOption('all')
  await expect(page.getByTestId('task-count')).toHaveText('5 tasks')

  const renamed = `Fix login bug for good ${batch}`
  await page.getByRole('link', { name: titles[3] }).click()
  await page.getByRole('link', { name: 'Edit task' }).click()
  await page.getByLabel('Title').fill(renamed)
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('heading', { name: renamed })).toBeVisible()

  await page.getByRole('link', { name: 'Back to tasks' }).click()
  await page.getByRole('link', { name: titles[4] }).click()
  await page.getByRole('button', { name: 'Delete task' }).click()
  await page.getByRole('button', { name: 'Confirm delete' }).click()
  await expect(page.getByTestId('task-count')).toHaveText('4 tasks')

  await page.getByRole('link', { name: 'Exports' }).click()
  await page.getByRole('button', { name: 'Start export' }).click()
  await expect(page.getByRole('list', { name: 'Exports' }).getByRole('listitem')).toContainText('done, 4 tasks')

  await page.getByRole('link', { name: 'Reports' }).click()
  await page.getByRole('button', { name: 'Build report' }).click()
  await expect(page.getByTestId('report-total')).toHaveText('4')
  await expect(page.getByTestId('report-done')).toHaveText('3')

  await page.getByRole('link', { name: 'Activity' }).click()
  const feed = page.getByRole('list', { name: 'Activity feed' })
  await expect(feed.getByText(`Deleted "${titles[4]}"`)).toBeVisible()
  await expect(feed.getByText(`Updated "${renamed}"`)).toBeVisible()

  await page.getByRole('button', { name: 'Log out' }).click()
  await expect(page.getByRole('link', { name: 'Create an account' })).toBeVisible()
})
