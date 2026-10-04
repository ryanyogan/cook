import { deleteCookie, getCookie, setCookie } from '@tanstack/react-start/server'
import { createSession, destroySession, userForSession } from './store'
import type { User } from '../lib/types'

const COOKIE = 'sid'

export function currentUser(): User | null {
  return userForSession(getCookie(COOKIE))
}

export function requireUser(): User {
  const user = currentUser()
  if (!user) throw new Error('Not signed in')
  return user
}

export function startSession(userId: number) {
  setCookie(COOKIE, createSession(userId), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  })
}

export function endSession() {
  const token = getCookie(COOKIE)
  if (token) destroySession(token)
  deleteCookie(COOKIE, { path: '/' })
}
