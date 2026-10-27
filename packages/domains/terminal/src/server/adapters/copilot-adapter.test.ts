/**
 * Tests for CopilotAdapter activity and error detection
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/domains/terminal/src/server/adapters/copilot-adapter.test.ts
 */
import { describe, expect, test } from 'vitest'
import { CopilotAdapter } from './copilot-adapter'

const adapter = new CopilotAdapter()

describe('CopilotAdapter.detectActivity', () => {
  test('returns null for generic output (input-driven detection)', () => {
    expect(adapter.detectActivity('Some TUI output', 'unknown')).toBe(null)
  })
})

describe('CopilotAdapter.detectPrompt', () => {
  test('detects Y/n prompt as permission', () => {
    expect(adapter.detectPrompt('Continue? [Y/n]')?.type).toBe('permission')
  })

  test('detects numbered menu as input prompt', () => {
    expect(adapter.detectPrompt('❯ 1. Continue')?.type).toBe('input')
  })

  test('detects question line as question prompt', () => {
    expect(adapter.detectPrompt('Should I proceed?')?.type).toBe('question')
  })
})

describe('CopilotAdapter.detectError', () => {
  test('detects stale session as SESSION_NOT_FOUND', () => {
    const result = adapter.detectError(
      'ERROR: No saved session found with ID 019c7a76-280a-7dc0-8af6-affe6cf174b2'
    )
    expect(result?.code).toBe('SESSION_NOT_FOUND')
  })

  test('detects auth errors', () => {
    const result = adapter.detectError('Please run copilot login to continue')
    expect(result?.code).toBe('AUTH_ERROR')
  })

  test('detects rate limits', () => {
    const result = adapter.detectError('429 Too Many Requests')
    expect(result?.code).toBe('RATE_LIMIT')
  })

  test('detects generic CLI errors', () => {
    const result = adapter.detectError('ERROR: Something went wrong')
    expect(result?.code).toBe('CLI_ERROR')
  })
})
