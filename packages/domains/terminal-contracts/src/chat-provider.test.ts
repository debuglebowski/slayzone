import { expect, test } from 'vitest'
import { chatProviderForBinary, chatProviderForMode } from './chat-provider'

test('Claude chat names Claude / Claude Code and its own files and pages', () => {
  expect(chatProviderForMode('claude-chat')).toEqual({
    type: 'claude-code',
    product: 'Claude Code',
    agent: 'Claude',
    binary: 'claude',
    memoryFile: 'CLAUDE.md',
    installUrl: 'https://claude.com/claude-code',
    issuesUrl: 'https://github.com/anthropics/claude-code/issues/new',
    releasesUrl: 'https://github.com/anthropics/claude-code/releases'
  })
})

test('Codex chat names Codex and its own files and pages', () => {
  expect(chatProviderForMode('codex-chat')).toEqual({
    type: 'codex',
    product: 'Codex',
    agent: 'Codex',
    binary: 'codex',
    memoryFile: 'AGENTS.md',
    installUrl: 'https://github.com/openai/codex',
    issuesUrl: 'https://github.com/openai/codex/issues/new',
    releasesUrl: 'https://github.com/openai/codex/releases'
  })
})

test('the terminal modes of the same CLI name the same provider', () => {
  expect(chatProviderForMode('claude-code').product).toBe('Claude Code')
  expect(chatProviderForMode('codex').agent).toBe('Codex')
})

test('an unknown mode falls back to Claude Code (the chat default)', () => {
  expect(chatProviderForMode('nope').agent).toBe('Claude')
})

test('by binary: the agent-problem card names what is not installed', () => {
  expect(chatProviderForBinary('codex')?.product).toBe('Codex')
  expect(chatProviderForBinary('claude')?.installUrl).toBe('https://claude.com/claude-code')
  expect(chatProviderForBinary('gemini')).toBeNull()
})
