import { expect, newAccount, test, visit } from './fixtures'

test.describe('sign up', () => {
  test('creates an account and lands on the task list', async ({ page }) => {
    const account = newAccount()
    await visit(page, '/signup')
    await page.getByLabel('Name').fill(account.name)
    await page.getByLabel('Email').fill(account.email)
    await page.getByLabel('Password').fill(account.password)
    await page.getByRole('button', { name: 'Sign up' }).click()

    await expect(page).toHaveURL(/\/tasks$/)
    await expect(page.getByTestId('current-user')).toHaveText(`Signed in as ${account.name}`)
    await expect(page.getByText('No tasks yet. Create your first one.')).toBeVisible()
  })

  test('shows an error for each invalid field', async ({ page }) => {
    await visit(page, '/signup')
    await page.getByLabel('Email').fill('not-an-email')
    await page.getByLabel('Password').fill('short')
    await page.getByRole('button', { name: 'Sign up' }).click()

    await expect(page.getByText('Name is required')).toBeVisible()
    await expect(page.getByText('Enter a valid email address')).toBeVisible()
    await expect(page.getByText('Password must be at least 8 characters')).toBeVisible()
    await expect(page).toHaveURL(/\/signup$/)
  })

  test('rejects an email that is already registered', async ({ page, browser }) => {
    const account = newAccount()
    const other = await browser.newContext()
    const created = await other.request.post('/api/signup', { data: account })
    expect(created.status()).toBe(201)
    await other.close()

    await visit(page, '/signup')
    await page.getByLabel('Name').fill('Someone Else')
    await page.getByLabel('Email').fill(account.email)
    await page.getByLabel('Password').fill('another-password')
    await page.getByRole('button', { name: 'Sign up' }).click()

    await expect(page.getByText('That email is already registered')).toBeVisible()
  })
})

test.describe('log in', () => {
  test('signs in with the right password', async ({ page, account }) => {
    await page.context().clearCookies()
    await visit(page, '/login')
    await page.getByLabel('Email').fill(account.email)
    await page.getByLabel('Password').fill(account.password)
    await page.getByRole('button', { name: 'Log in' }).click()

    await expect(page).toHaveURL(/\/tasks$/)
    await expect(page.getByTestId('current-user')).toHaveText(`Signed in as ${account.name}`)
  })

  test('rejects a wrong password', async ({ page, account }) => {
    await page.context().clearCookies()
    await visit(page, '/login')
    await page.getByLabel('Email').fill(account.email)
    await page.getByLabel('Password').fill('definitely-wrong')
    await page.getByRole('button', { name: 'Log in' }).click()

    await expect(page.getByRole('alert')).toHaveText('Invalid email or password')
    await expect(page).toHaveURL(/\/login$/)
  })
})

test.describe('session', () => {
  test('survives a page reload', async ({ page, account }) => {
    await visit(page, '/tasks')
    await page.reload()
    await expect(page.getByTestId('current-user')).toHaveText(`Signed in as ${account.name}`)
    await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()
  })

  test('ends on log out', async ({ page, account }) => {
    await visit(page, '/tasks')
    await expect(page.getByTestId('current-user')).toContainText(account.name)
    await page.getByRole('button', { name: 'Log out' }).click()

    await expect(page.getByRole('link', { name: 'Create an account' })).toBeVisible()
    await expect(page.getByTestId('current-user')).toHaveCount(0)

    await visit(page, '/tasks')
    await expect(page).toHaveURL(/\/login$/)
  })

  test('is required for the task list', async ({ page }) => {
    await visit(page, '/tasks')
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible()
  })

})
