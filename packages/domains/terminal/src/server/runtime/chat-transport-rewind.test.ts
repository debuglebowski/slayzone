/**
 * Chat A — edit & resend, rewind to here, and code rewind (plan 3.3), at the
 * transport: the right control requests in the right order, the target message
 * the server resolves, the saved branch marker, and the files notice. Fake
 * children answer like Claude Code 2.1.312 (spike items 5 + 6).
 */
import { afterEach, expect, test } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import * as mgr from './chat-transport-manager'
import {
  emitLine,
  type FakeChild,
  sendAndStart,
  sj,
  startTab,
  TAB_OPTS,
  transportHarness,
  until
} from './chat-transport-testkit'

const respawnOpts = async () => ({ ...TAB_OPTS })

afterEach(() => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
})

/** A finished turn for message `id` (lifecycle + answer + result + completed). */
async function turn(f: FakeChild, id: string, text: string): Promise<void> {
  await sendAndStart(f, id, text)
  emitLine(f, sj.text(`re: ${text}`, { uuid: `a-${id}` }))
  emitLine(f, sj.success())
  emitLine(f, sj.lifecycle(id, 'completed'))
  await until(() => mgr.isReadyForQueuedMessage(TAB_OPTS.tabId))
}

/** The CLI's answers for rewinds (the conversation knows `known`). */
function answersRewinds(f: FakeChild, known: string[]): void {
  f.answer('rewind_conversation', (r) =>
    known.includes(String(r.target_message_uuid))
      ? {
          success: {
            rewound: true,
            targetMessageUuid: r.target_message_uuid,
            prefillText: `text of ${String(r.target_message_uuid)}`,
            precedingAssistantUuid: null
          }
        }
      : {
          success: {
            rewound: false,
            prefillText: null,
            precedingAssistantUuid: null,
            error: 'target not found',
            reason: 'target_not_found'
          }
        }
  )
  f.answer('rewind_files', (r) =>
    r.dry_run === true
      ? { success: { canRewind: true, filesChanged: ['/repo/a.txt'], insertions: 1, deletions: 2 } }
      : { success: { canRewind: true, skippedLinks: 0 } }
  )
}

const branches = (saved: AgentEvent[]) => saved.filter((e) => e.kind === 'conversation-branch')

test('Claude chat spawns with file checkpointing on (rewind_files needs it)', async () => {
  let env: NodeJS.ProcessEnv | undefined
  transportHarness()
  mgr.configureTransport({
    spawn: (_cmd, _args, opts) => {
      env = opts.env
      throw new Error('captured')
    }
  })
  await mgr.hydrateSession({ ...TAB_OPTS })
  await mgr.ensureSpawned(TAB_OPTS.tabId).catch(() => undefined)
  expect(env?.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBe('true')
})

test('preview: a dry run of the files for the message (before) or the next one (after)', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  answersRewinds(f, ['u1', 'u2'])
  await turn(f, 'u1', 'one')
  await turn(f, 'u2', 'two')

  const before = await mgr.previewRewind(TAB_OPTS.tabId, { messageId: 'u1', scope: 'before' })
  const after = await mgr.previewRewind(TAB_OPTS.tabId, { messageId: 'u1', scope: 'after' })

  expect(before).toEqual({
    canRewind: true,
    filesChanged: ['/repo/a.txt'],
    insertions: 1,
    deletions: 2
  })
  expect(after.canRewind).toBe(true)
  expect(f.controlRequests('rewind_files')).toEqual([
    { subtype: 'rewind_files', user_message_id: 'u1', dry_run: true },
    { subtype: 'rewind_files', user_message_id: 'u2', dry_run: true }
  ])
})

test('edit & resend with code: files first, then the conversation; a marker and a files notice', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  answersRewinds(f, ['u1', 'u2'])
  await turn(f, 'u1', 'one')
  await turn(f, 'u2', 'two')

  const result = await mgr.rewindTab(TAB_OPTS.tabId, {
    messageId: 'u2',
    scope: 'before',
    conversation: true,
    files: true,
    respawnOpts
  })

  expect(result.prefillText).toBe('text of u2')
  expect(result.files).toEqual({ restored: true, filesChanged: ['/repo/a.txt'] })
  expect(f.controlSubtypes()).toEqual(['rewind_files', 'rewind_files', 'rewind_conversation'])
  expect(f.controlRequests('rewind_files')[1]).toEqual({
    subtype: 'rewind_files',
    user_message_id: 'u2'
  })
  expect(branches(h.saved())).toEqual([
    { kind: 'conversation-branch', reason: 'rewound', messageId: 'u2' }
  ])
  expect(h.saved().find((e) => e.kind === 'notice')).toMatchObject({ code: 'files-rewound' })
  expect(h.fakes).toHaveLength(1)
})

test('rewind to here targets the NEXT message, and later rewinds skip what was already rewound', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  answersRewinds(f, ['u1', 'u2', 'u3'])
  await turn(f, 'u1', 'one')
  await turn(f, 'u2', 'two')
  await turn(f, 'u3', 'three')

  await mgr.rewindTab(TAB_OPTS.tabId, {
    messageId: 'u2',
    scope: 'after',
    conversation: true,
    files: false,
    respawnOpts
  })
  expect(f.controlRequests('rewind_conversation')).toEqual([
    { subtype: 'rewind_conversation', target_message_uuid: 'u3' }
  ])
  // u3 is gone from the conversation: nothing follows u2 any more.
  await expect(
    mgr.rewindTab(TAB_OPTS.tabId, {
      messageId: 'u2',
      scope: 'after',
      conversation: true,
      files: false,
      respawnOpts
    })
  ).rejects.toThrow(/nothing after/i)
  await expect(
    mgr.rewindTab(TAB_OPTS.tabId, {
      messageId: 'u3',
      scope: 'before',
      conversation: true,
      files: false,
      respawnOpts
    })
  ).rejects.toThrow(/not in the conversation/i)
})

test('code only: files are restored, the conversation stays (no marker)', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  answersRewinds(f, ['u1'])
  await turn(f, 'u1', 'one')

  const result = await mgr.rewindTab(TAB_OPTS.tabId, {
    messageId: 'u1',
    scope: 'before',
    conversation: false,
    files: true,
    respawnOpts
  })
  expect(result.prefillText).toBeNull()
  expect(f.controlRequests('rewind_conversation')).toEqual([])
  expect(branches(h.saved())).toEqual([])
  expect(h.saved().find((e) => e.kind === 'notice')).toMatchObject({ code: 'files-rewound' })
})

test('the CLI not knowing the message is an error, and nothing is marked', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  answersRewinds(f, [])
  await turn(f, 'u1', 'one')
  await expect(
    mgr.rewindTab(TAB_OPTS.tabId, {
      messageId: 'u1',
      scope: 'before',
      conversation: true,
      files: false,
      respawnOpts
    })
  ).rejects.toThrow(/target not found/)
  expect(branches(h.saved())).toEqual([])
})

test('a message without an id (from before message ids) cannot be rewound', async () => {
  const h = transportHarness({
    history: [{ seq: 0, event: { kind: 'user-message', text: 'old' } }]
  })
  await startTab()
  answersRewinds(h.fakes[0], [])
  await expect(
    mgr.rewindTab(TAB_OPTS.tabId, {
      messageId: 'nope',
      scope: 'before',
      conversation: true,
      files: false,
      respawnOpts
    })
  ).rejects.toThrow(/not in the conversation/i)
})

test('a running turn is stopped (live interrupt) before the rewind', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  answersRewinds(f, ['u1', 'u2'])
  f.answer('interrupt', () => {
    setImmediate(() => {
      emitLine(f, sj.aborted())
      emitLine(f, sj.lifecycle('u2', 'cancelled'))
    })
    return { success: { still_queued: [] } }
  })
  await turn(f, 'u1', 'one')
  await sendAndStart(f, 'u2', 'two')
  emitLine(f, sj.text('working'))
  await until(() => h.savedKinds().filter((k) => k === 'assistant-text').length === 2)

  await mgr.rewindTab(TAB_OPTS.tabId, {
    messageId: 'u1',
    scope: 'after',
    conversation: true,
    files: false,
    respawnOpts
  })

  expect(f.controlSubtypes()).toEqual(['interrupt', 'rewind_conversation'])
  expect(h.fakes).toHaveLength(1)
})
