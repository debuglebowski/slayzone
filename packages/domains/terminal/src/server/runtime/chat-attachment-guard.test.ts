/**
 * The server's gate for attached files: only a tab whose chat takes them, only
 * files of the tab's own task, within the conversation's budget — and each
 * file sealed to the exact bytes it had when the message was taken.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/domains/terminal/src/server/runtime/chat-attachment-guard.test.ts
 */
import { describe, expect, test } from 'vitest'
import type { AgentEvent, ChatAttachment, UserContentBlock } from '@slayzone/terminal-contracts'
import {
  admitAttachments,
  budgetEntriesFromEvents,
  type AttachmentLookup
} from './chat-attachment-guard'

const MiB = 1024 * 1024

const file = (artifactId: string, over: Partial<ChatAttachment> = {}): ChatAttachment => ({
  artifactId,
  name: `${artifactId}.pdf`,
  kind: 'pdf',
  mediaType: 'application/pdf',
  size: 1000,
  ...over
})
const block = (a: ChatAttachment): UserContentBlock => ({ type: 'attachment', attachment: a })
const text = (t: string): UserContentBlock => ({ type: 'text', text: t })

function lookup(over: Partial<AttachmentLookup> = {}): AttachmentLookup & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    tab: async (tabId) => {
      calls.push(`tab:${tabId}`)
      return { taskId: 'task-1', mode: 'claude-chat' }
    },
    artifacts: async (ids) => {
      calls.push(`artifacts:${ids.join(',')}`)
      return new Map(
        ids.map((id) => [
          id,
          { taskId: id.startsWith('other') ? 'task-2' : 'task-1', contentHash: `h-${id}` }
        ])
      )
    },
    queued: async () => [],
    hasVersion: async (artifactId, hash) => hash === `h-${artifactId}` || hash === 'old',
    ...over
  }
}

describe('admitAttachments', () => {
  test('text-only content passes untouched without any lookup', async () => {
    const l = lookup()
    const content = [text('hi')]
    expect(await admitAttachments({ tabId: 't', content, lookup: l, events: [] })).toBe(content)
    expect(l.calls).toEqual([])
  })

  test('seals each file to its current content hash; text unchanged', async () => {
    const out = await admitAttachments({
      tabId: 't',
      content: [block(file('a')), text('/x')],
      lookup: lookup(),
      events: []
    })
    expect(out).toEqual([block(file('a', { contentHash: 'h-a' })), text('/x')])
  })

  test('a hash that is not a version of THAT artifact is replaced (blobs are shared by hash)', async () => {
    const out = await admitAttachments({
      tabId: 't',
      content: [block(file('a', { contentHash: 'h-someone-elses-file' }))],
      lookup: lookup(),
      events: []
    })
    expect(out).toEqual([block(file('a', { contentHash: 'h-a' }))])
  })

  test('an already sealed file (a queued message edited) keeps its hash', async () => {
    const out = await admitAttachments({
      tabId: 't',
      content: [block(file('a', { contentHash: 'old' }))],
      lookup: lookup(),
      events: []
    })
    expect(out).toEqual([block(file('a', { contentHash: 'old' }))])
  })

  test('a file of another task (or no file at all) is refused', async () => {
    await expect(
      admitAttachments({
        tabId: 't',
        content: [block(file('other-x'))],
        lookup: lookup(),
        events: []
      })
    ).rejects.toThrow(/other-x\.pdf is not a file of this task/)
    await expect(
      admitAttachments({
        tabId: 't',
        content: [block(file('gone'))],
        lookup: lookup({ artifacts: async () => new Map() }),
        events: []
      })
    ).rejects.toThrow(/gone\.pdf/)
  })

  test('a chat that takes no files (Codex) refuses them', async () => {
    await expect(
      admitAttachments({
        tabId: 't',
        content: [block(file('a'))],
        lookup: lookup({ tab: async () => ({ taskId: 'task-1', mode: 'codex-chat' }) }),
        events: []
      })
    ).rejects.toThrow(/can't take attached files/)
  })

  test('the conversation budget counts sent and queued files since the last compaction', async () => {
    const sent: AgentEvent[] = [
      {
        kind: 'user-message',
        id: 'm0',
        text: '',
        content: [block(file('old', { size: 20 * MiB }))]
      },
      { kind: 'compact-boundary', trigger: 'manual', preTokens: 1 } as AgentEvent,
      { kind: 'user-message', id: 'm1', text: '', content: [block(file('b', { size: 9 * MiB }))] }
    ]
    const queued = async (): Promise<ChatAttachment[]> => [file('q', { size: 6 * MiB })]
    // 12 MiB (b) + 8 MiB (q) used; + 4 MiB fits 24, + 6 MiB doesn't.
    await expect(
      admitAttachments({
        tabId: 't',
        content: [block(file('c', { size: 3 * MiB }))],
        lookup: lookup({ queued }),
        events: sent
      })
    ).resolves.toBeDefined()
    await expect(
      admitAttachments({
        tabId: 't',
        content: [block(file('c', { size: 4 * MiB }))],
        lookup: lookup({ queued }),
        events: sent
      })
    ).rejects.toThrow(/\/compact/)
  })

  test('budget boundaries: compaction and a fresh conversation', () => {
    const events: AgentEvent[] = [
      { kind: 'user-message', id: 'm0', text: '', content: [block(file('a'))] },
      {
        kind: 'notice',
        id: 'n',
        level: 'warning',
        text: 'fresh',
        code: 'resume-failed-fresh-start'
      },
      { kind: 'user-message', id: 'm1', text: 'x' }
    ]
    expect(budgetEntriesFromEvents(events)).toEqual([
      { type: 'message', id: 'm0', attachments: [file('a')] },
      { type: 'boundary' },
      { type: 'message', id: 'm1', attachments: [] }
    ])
  })
})
