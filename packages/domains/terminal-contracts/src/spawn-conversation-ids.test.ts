/**
 * spawnConversationIds — the conversation ids a fresh agent spawn passes to
 * `pty.create`, shared by the desktop terminal and the hub's `task.startMainAgent`.
 */
import { expect, test } from 'vitest'
import { spawnConversationIds } from './spawn-conversation-ids.js'

const mint = (): string => 'minted'

test('a pre-mint mode with nothing to resume mints a fresh id', () => {
  expect(
    spawnConversationIds(
      {
        mode: 'claude-code',
        supportsSessionId: true,
        conversationId: undefined,
        existingConversationId: undefined
      },
      mint
    )
  ).toEqual({ conversationId: 'minted', existingConversationId: undefined })
})

test('a conversation to resume is passed through, never re-minted', () => {
  expect(
    spawnConversationIds(
      {
        mode: 'claude-code',
        supportsSessionId: true,
        conversationId: 'c1',
        existingConversationId: 'c1'
      },
      mint
    )
  ).toEqual({ conversationId: 'c1', existingConversationId: 'c1' })
})

test('a provider that mints its own ids gets none from us', () => {
  expect(
    spawnConversationIds(
      {
        mode: 'codex',
        supportsSessionId: false,
        conversationId: null,
        existingConversationId: null
      },
      mint
    )
  ).toEqual({ conversationId: null, existingConversationId: null })
})

test('a plain terminal carries no conversation at all', () => {
  expect(
    spawnConversationIds(
      {
        mode: 'terminal',
        supportsSessionId: true,
        conversationId: 'c',
        existingConversationId: 'c'
      },
      mint
    )
  ).toEqual({ conversationId: undefined, existingConversationId: undefined })
})
