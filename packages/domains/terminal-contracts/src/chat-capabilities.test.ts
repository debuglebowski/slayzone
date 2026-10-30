import { expect, test } from 'vitest'
import { CHAT_SUPPORTED_MODES } from './types'
import {
  chatCapabilitiesForMode,
  chatModeForTerminal,
  terminalModeForChat
} from './chat-capabilities'

test('Claude Code chat: every capability', () => {
  expect(chatCapabilitiesForMode('claude-chat')).toEqual({
    nativeSlashCommands: true,
    promptHistory: true,
    promptCards: true,
    liveInterrupt: true,
    liveEffort: true,
    rewind: true,
    fork: true,
    sessions: true,
    handoff: true,
    attachments: 'blocks',
    restoreComposerState: true,
    editableQueue: true,
    filesChanged: true,
    diffComments: true,
    commandPalette: true
  })
})

test('Codex chat keeps today’s behavior: no new capabilities', () => {
  expect(chatCapabilitiesForMode('codex-chat')).toEqual({
    nativeSlashCommands: false,
    promptHistory: false,
    promptCards: false,
    liveInterrupt: false,
    liveEffort: false,
    rewind: false,
    fork: false,
    sessions: false,
    handoff: false,
    attachments: 'paths',
    restoreComposerState: false,
    editableQueue: false,
    filesChanged: false,
    diffComments: false,
    commandPalette: false
  })
})

test('unknown / non-chat modes get nothing', () => {
  expect(chatCapabilitiesForMode('terminal')).toEqual({
    nativeSlashCommands: false,
    promptHistory: false,
    promptCards: false,
    liveInterrupt: false,
    liveEffort: false,
    rewind: false,
    fork: false,
    sessions: false,
    handoff: false,
    attachments: 'paths',
    restoreComposerState: false,
    editableQueue: false,
    filesChanged: false,
    diffComments: false,
    commandPalette: false
  })
})

test('every chat-capable mode has an explicit entry', () => {
  for (const mode of CHAT_SUPPORTED_MODES) {
    expect(() => chatCapabilitiesForMode(mode)).not.toThrow()
  }
})

test('hand-off partners: Claude chat <-> the Claude Code terminal; nothing for others', () => {
  expect(terminalModeForChat('claude-chat')).toBe('claude-code')
  expect(chatModeForTerminal('claude-code')).toBe('claude-chat')
  expect(terminalModeForChat('codex-chat')).toBeNull()
  expect(chatModeForTerminal('codex')).toBeNull()
})
