import { expect, test } from 'vitest'
import { apiRetryReason, formatRetrySpan } from './api-retry'

test('apiRetryReason: category in words, with the HTTP status when there is one', () => {
  expect(apiRetryReason('unknown', null)).toBe('no response from API')
  expect(apiRetryReason('unknown', 502)).toBe('HTTP 502')
  expect(apiRetryReason('unknown')).toBe('unknown error')
  expect(apiRetryReason('overloaded', 529)).toBe('API overloaded (529)')
  expect(apiRetryReason('rate_limit', 429)).toBe('rate limited (429)')
  expect(apiRetryReason('server_error', 500)).toBe('server error (500)')
  expect(apiRetryReason('max_output_tokens', null)).toBe('max output tokens')
})

test('formatRetrySpan: whole seconds, minutes past 60s', () => {
  expect(formatRetrySpan(571)).toBe('1s')
  expect(formatRetrySpan(34_765)).toBe('35s')
  expect(formatRetrySpan(70_000)).toBe('1m 10s')
})
