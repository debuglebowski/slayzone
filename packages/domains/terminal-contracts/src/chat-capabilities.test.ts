import { expect, test } from 'vitest'
import { CHAT_SUPPORTED_MODES } from './types'
import { chatCapabilitiesForMode } from './chat-capabilities'

test('Claude Code chat: native slash commands + prompt history', () => {
  expect(chatCapabilitiesForMode('claude-chat')).toEqual({
    nativeSlashCommands: true,
    promptHistory: true
  })
})

test('Codex chat keeps today’s behavior: no new capabilities', () => {
  expect(chatCapabilitiesForMode('codex-chat')).toEqual({
    nativeSlashCommands: false,
    promptHistory: false
  })
})

test('unknown / non-chat modes get nothing', () => {
  expect(chatCapabilitiesForMode('terminal')).toEqual({
    nativeSlashCommands: false,
    promptHistory: false
  })
})

test('every chat-capable mode has an explicit entry', () => {
  for (const mode of CHAT_SUPPORTED_MODES) {
    expect(() => chatCapabilitiesForMode(mode)).not.toThrow()
  }
})
