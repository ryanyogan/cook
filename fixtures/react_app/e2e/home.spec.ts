import { expect, test, visit } from './fixtures'

test('home page invites a visitor to sign up or log in', async ({ page }) => {
  await visit(page, '/')
  await expect(page.getByRole('heading', { name: 'Keep track of what needs doing' })).toBeVisible()

  await page.getByRole('link', { name: 'Create an account' }).click()
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()
})

test('home page greets a signed-in user by name', async ({ page, account }) => {
  await visit(page, '/')
  await expect(page.getByText(`Welcome back, ${account.name}.`)).toBeVisible()

  await page.getByRole('link', { name: 'Go to your tasks' }).click()
  await expect(page).toHaveURL(/\/tasks$/)
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()
})

