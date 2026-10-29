import { expect, test } from 'vitest'
import { CHAT_SUPPORTED_MODES } from './types'
import { chatCapabilitiesForMode } from './chat-capabilities'

test('Claude Code chat: native slash commands + prompt history + prompt cards', () => {
  expect(chatCapabilitiesForMode('claude-chat')).toEqual({
    nativeSlashCommands: true,
    promptHistory: true,
    promptCards: true
  })
})

test('Codex chat keeps today’s behavior: no new capabilities', () => {
  expect(chatCapabilitiesForMode('codex-chat')).toEqual({
    nativeSlashCommands: false,
    promptHistory: false,
    promptCards: false
  })
})

test('unknown / non-chat modes get nothing', () => {
  expect(chatCapabilitiesForMode('terminal')).toEqual({
    nativeSlashCommands: false,
    promptHistory: false,
    promptCards: false
  })
})

test('every chat-capable mode has an explicit entry', () => {
  for (const mode of CHAT_SUPPORTED_MODES) {
    expect(() => chatCapabilitiesForMode(mode)).not.toThrow()
  }
})
