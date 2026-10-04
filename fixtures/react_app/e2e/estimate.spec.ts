import { createTask, expect, test, uid, visit } from './fixtures'

// FLAKY ON PURPOSE. The effort estimator stands in for an unreliable third-party
// service: the server fails about one request in five (ESTIMATOR_FAILURE_RATE in
// src/server/store.ts) and the page then shows an error instead of an estimate.
test('FLAKY: effort estimate appears for a task', { tag: '@flaky' }, async ({ page, account }) => {
  void account
  const task = await createTask(page, `Estimate me ${uid()}`, 'high')

  await visit(page, `/tasks/${task.id}`)
  await page.getByRole('button', { name: 'Estimate effort' }).click()

  const estimate = page.getByTestId('estimate')
  await expect(estimate.or(page.getByRole('alert'))).toBeVisible()
  // Checked once, not polled: by now the page shows either the estimate or the error.
  expect(await page.getByRole('alert').count(), 'the estimator answered with an error').toBe(0)
  await expect(estimate).toHaveText(/Estimated effort: \d+ minutes/)
})
