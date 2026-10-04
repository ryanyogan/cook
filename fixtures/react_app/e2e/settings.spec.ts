import { expect, test, uid, visit } from './fixtures'

test('changing the display name updates the header', async ({ page, account }) => {
  const renamed = `Renamed ${uid()}`
  await visit(page, '/settings')
  await expect(page.getByText(`Account email: ${account.email}`)).toBeVisible()

  await page.getByLabel('Display name').fill(renamed)
  await page.getByRole('button', { name: 'Save settings' }).click()

  await expect(page.getByRole('status')).toHaveText('Settings saved')
  await expect(page.getByTestId('current-user')).toHaveText(`Signed in as ${renamed}`)
})

test('a blank display name is rejected', async ({ page, account }) => {
  await visit(page, '/settings')
  await page.getByLabel('Display name').fill('   ')
  await page.getByRole('button', { name: 'Save settings' }).click()

  await expect(page.getByText('Name is required')).toBeVisible()
  await expect(page.getByTestId('current-user')).toHaveText(`Signed in as ${account.name}`)
})

test('the new name is still there after logging in again', async ({ page, account }) => {
  const renamed = `Persistent ${uid()}`
  await visit(page, '/settings')
  await page.getByLabel('Display name').fill(renamed)
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('status')).toHaveText('Settings saved')

  await page.getByRole('button', { name: 'Log out' }).click()
  await expect(page.getByRole('link', { name: 'Create an account' })).toBeVisible()
  await page.getByRole('link', { name: 'Log in', exact: true }).click()
  await page.getByLabel('Email').fill(account.email)
  await page.getByLabel('Password').fill(account.password)
  await page.getByRole('button', { name: 'Log in' }).click()

  await expect(page.getByTestId('current-user')).toHaveText(`Signed in as ${renamed}`)
})
