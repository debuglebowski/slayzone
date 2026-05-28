/**
 * Auth-error classifier contract tests
 * Run with: npx tsx packages/domains/integrations/src/main/sync.test.ts
 */
import assert from 'node:assert/strict'
import { isAuthError } from './sync-classifiers.js'

// Linear shape — see linear-client.ts:135
assert.equal(
  isAuthError(new Error('Linear API request failed: HTTP 401 - {"errors":[{"message":"..."}]}')),
  true,
  'Linear 401 should classify as auth'
)
assert.equal(
  isAuthError(new Error('Linear API request failed: HTTP 403 - forbidden')),
  true,
  'Linear 403 should classify as auth'
)

// GitHub shape — see github-client.ts:177
assert.equal(
  isAuthError(new Error('GitHub API request failed: HTTP 401 - Bad credentials')),
  true,
  'GitHub 401 should classify as auth'
)

// Jira shape
assert.equal(
  isAuthError(new Error('Jira API request failed: HTTP 401 - unauthorized')),
  true,
  'Jira 401 should classify as auth'
)

// Non-auth HTTP errors
assert.equal(
  isAuthError(new Error('Linear API request failed: HTTP 500 - server error')),
  false,
  '500 should NOT classify as auth'
)
assert.equal(
  isAuthError(new Error('Linear API request failed: HTTP 404 - not found')),
  false,
  '404 should NOT classify as auth'
)

// Network errors
assert.equal(isAuthError(new Error('fetch failed')), false, 'fetch failed is network, not auth')
assert.equal(
  isAuthError(new Error('ENOTFOUND api.linear.app')),
  false,
  'ENOTFOUND is network, not auth'
)

// Non-Error inputs
assert.equal(isAuthError('HTTP 401'), false, 'string input must be Error')
assert.equal(isAuthError(null), false, 'null input must be Error')
assert.equal(isAuthError(undefined), false, 'undefined input must be Error')

// Word-boundary safety — don't match e.g. "HTTP 4011"
assert.equal(
  isAuthError(new Error('Linear API request failed: HTTP 4011 - bogus')),
  false,
  'HTTP 4011 should not match (word boundary)'
)

console.log('✓ sync.test.ts — isAuthError contract OK')
