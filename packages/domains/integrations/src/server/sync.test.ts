/**
 * Auth-error classifier contract tests
 */
import { describe, expect, test } from 'vitest'
import { isAuthError } from './sync-classifiers.js'

describe('isAuthError', () => {
  // Linear shape — see linear-client.ts:135
  test('Linear 401 should classify as auth', () => {
    expect(
      isAuthError(new Error('Linear API request failed: HTTP 401 - {"errors":[{"message":"..."}]}'))
    ).toBe(true)
  })
  test('Linear 403 should classify as auth', () => {
    expect(isAuthError(new Error('Linear API request failed: HTTP 403 - forbidden'))).toBe(true)
  })

  // GitHub shape — see github-client.ts:177
  test('GitHub 401 should classify as auth', () => {
    expect(isAuthError(new Error('GitHub API request failed: HTTP 401 - Bad credentials'))).toBe(
      true
    )
  })

  // Jira shape
  test('Jira 401 should classify as auth', () => {
    expect(isAuthError(new Error('Jira API request failed: HTTP 401 - unauthorized'))).toBe(true)
  })

  // Non-auth HTTP errors
  test('500 should NOT classify as auth', () => {
    expect(isAuthError(new Error('Linear API request failed: HTTP 500 - server error'))).toBe(false)
  })
  test('404 should NOT classify as auth', () => {
    expect(isAuthError(new Error('Linear API request failed: HTTP 404 - not found'))).toBe(false)
  })

  // Network errors
  test('fetch failed is network, not auth', () => {
    expect(isAuthError(new Error('fetch failed'))).toBe(false)
  })
  test('ENOTFOUND is network, not auth', () => {
    expect(isAuthError(new Error('ENOTFOUND api.linear.app'))).toBe(false)
  })

  // Non-Error inputs
  test('string input must be Error', () => {
    expect(isAuthError('HTTP 401')).toBe(false)
  })
  test('null input must be Error', () => {
    expect(isAuthError(null)).toBe(false)
  })
  test('undefined input must be Error', () => {
    expect(isAuthError(undefined)).toBe(false)
  })

  // Word-boundary safety — don't match e.g. "HTTP 4011"
  test('HTTP 4011 should not match (word boundary)', () => {
    expect(isAuthError(new Error('Linear API request failed: HTTP 4011 - bogus'))).toBe(false)
  })
})
