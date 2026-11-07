import { expect, test } from 'vitest'
import { CHAT_SUPPORTED_MODES } from './types'
import {
  chatCapabilitiesForMode,
  chatAgentIdForTerminal,
  terminalAgentIdForChat
} from './chat-capabilities'

test('Claude Code chat: every capability', () => {
  expect(chatCapabilitiesForMode('claude-chat')).toEqual({
    nativeSlashCommands: true,
    promptHistory: true,
    promptCards: true,
    liveInterrupt: true,
    liveEffort: true,
    liveSettingsMidTurn: true,
    rewind: true,
    fork: true,
    sessions: true,
    handoff: true,
    attachments: 'blocks',
    attachmentKinds: ['image', 'pdf', 'text'],
    restoreComposerState: true,
    editableQueue: true,
    filesChanged: true,
    diffComments: true,
    commandPalette: true,
    compact: true,
    sideQuestions: true,
    steerQueued: true,
    withdrawSteered: true,
    agentStartedTurns: true,
    stopSubAgent: true
  })
})

test('Codex chat: prompt cards, live Stop + effort, rewind, fork, sessions, compact, side questions, files changed', () => {
  expect(chatCapabilitiesForMode('codex-chat')).toEqual({
    nativeSlashCommands: false,
    promptHistory: true,
    promptCards: true,
    liveInterrupt: true,
    liveEffort: true,
    liveSettingsMidTurn: false,
    rewind: true,
    fork: true,
    sessions: true,
    handoff: false,
    attachments: 'blocks',
    attachmentKinds: ['image'],
    restoreComposerState: true,
    editableQueue: false,
    filesChanged: true,
    diffComments: true,
    commandPalette: true,
    compact: true,
    sideQuestions: true,
    steerQueued: true,
    withdrawSteered: false,
    agentStartedTurns: false,
    stopSubAgent: true
  })
})

test('unknown / non-chat modes get nothing', () => {
  expect(chatCapabilitiesForMode('terminal')).toEqual({
    nativeSlashCommands: false,
    promptHistory: false,
    promptCards: false,
    liveInterrupt: false,
    liveEffort: false,
    liveSettingsMidTurn: false,
    rewind: false,
    fork: false,
    sessions: false,
    handoff: false,
    attachments: 'paths',
    attachmentKinds: ['image'],
    restoreComposerState: false,
    editableQueue: false,
    filesChanged: false,
    diffComments: false,
    commandPalette: false,
    compact: false,
    sideQuestions: false,
    steerQueued: false,
    withdrawSteered: false,
    agentStartedTurns: false,
    stopSubAgent: false
  })
})

test('every chat-capable mode has an explicit entry', () => {
  for (const mode of CHAT_SUPPORTED_MODES) {
    expect(() => chatCapabilitiesForMode(mode)).not.toThrow()
  }
})

test('every chat-capable mode supports task prompt history', () => {
  for (const mode of CHAT_SUPPORTED_MODES) {
    expect(chatCapabilitiesForMode(mode).promptHistory, mode).toBe(true)
  }
})

test('hand-off partners: Claude chat <-> the Claude Code terminal; nothing for others', () => {
  expect(terminalAgentIdForChat('claude-chat')).toBe('claude-code')
  expect(chatAgentIdForTerminal('claude-code')).toBe('claude-chat')
  expect(terminalAgentIdForChat('codex-chat')).toBeNull()
  expect(chatAgentIdForTerminal('codex')).toBeNull()
})
