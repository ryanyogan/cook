import { randomUUID } from 'node:crypto'
import { test as base, expect, type Page } from '@playwright/test'

export interface Account {
  name: string
  email: string
  password: string
}

export interface TaskData {
  id: number
  title: string
  priority: string
}

/** Short random suffix. Every name, email and title in the suite carries one. */
export const uid = () => randomUUID().slice(0, 8)

export function newAccount(): Account {
  const id = uid()
  return { name: `User ${id}`, email: `user-${id}@example.test`, password: `pw-${id}-secret` }
}

/** Opens a server-rendered page and waits until React has attached its handlers. */
export async function visit(page: Page, path: string) {
  await page.goto(path)
  await expect(page.locator('html[data-hydrated="true"]')).toBeAttached()
}

/** Creates a task for the signed-in user through the JSON API. */
export async function createTask(page: Page, title: string, priority = 'normal'): Promise<TaskData> {
  const response = await page.request.post('/api/tasks', { data: { title, priority } })
  expect(response.status()).toBe(201)
  return (await response.json()).task
}

export const taskItem = (page: Page, title: string) =>
  page.getByRole('list', { name: 'Tasks' }).getByRole('listitem').filter({ hasText: title })

export const test = base.extend<{ account: Account }>({
  /** A brand-new user, already signed in on `page`. No test shares one. */
  account: async ({ page }, use) => {
    const account = newAccount()
    const response = await page.request.post('/api/signup', { data: account })
    expect(response.status()).toBe(201)
    await use(account)
  },
})

export { expect }
