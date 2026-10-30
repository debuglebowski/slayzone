/**
 * A chat tab's composer state (`chat_tab_state`, migration v177): its draft
 * (text + attached files) and timeline scroll anchor, so neither is lost to a
 * remount or a reload.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/domains/terminal/src/server/chat-tab-state-store.test.ts
 */
import { describe, expect, test } from 'vitest'
import type { ChatAttachment } from '@slayzone/terminal-contracts'
import { createTestHarness, type TestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { getChatTabState, saveChatDraft, saveChatScroll } from './chat-tab-state-store'

function seedTab(h: TestHarness, tabId = 'tab-1'): void {
  h.db.prepare("INSERT OR IGNORE INTO projects (id, name, color) VALUES ('p1', 'P', '#000')").run()
  h.db.prepare("INSERT OR IGNORE INTO tasks (id, project_id, title) VALUES ('t1', 'p1', 'T')").run()
  h.db
    .prepare(
      "INSERT INTO terminal_tabs (id, task_id, mode, position) VALUES (?, 't1', 'claude-chat', 0)"
    )
    .run(tabId)
}

const FILE: ChatAttachment = {
  artifactId: 'a1',
  name: 'red.png',
  kind: 'image',
  mediaType: 'image/png',
  size: 9
}

describe('chat tab state', () => {
  test('nothing saved: null', async () => {
    const h = await createTestHarness()
    try {
      seedTab(h)
      expect(await getChatTabState(h.slayDb, 'tab-1')).toBeNull()
    } finally {
      h.cleanup()
    }
  })

  test('a draft (text + files) is saved and read back; each save bumps the revision', async () => {
    const h = await createTestHarness()
    try {
      seedTab(h)
      expect(
        await saveChatDraft(h.slayDb, 'tab-1', { text: 'half a thought', attachments: [FILE] })
      ).toEqual({
        rev: 1
      })
      expect(await getChatTabState(h.slayDb, 'tab-1')).toEqual({
        draft: { text: 'half a thought', attachments: [FILE], rev: 1 },
        scroll: null
      })
      expect(await saveChatDraft(h.slayDb, 'tab-1', { text: '', attachments: [] })).toEqual({
        rev: 2
      })
      expect((await getChatTabState(h.slayDb, 'tab-1'))?.draft).toEqual({
        text: '',
        attachments: [],
        rev: 2
      })
    } finally {
      h.cleanup()
    }
  })

  test('scroll and draft are saved independently', async () => {
    const h = await createTestHarness()
    try {
      seedTab(h)
      await saveChatScroll(h.slayDb, 'tab-1', { atBottom: false, key: 'user:m1', offsetPx: 42 })
      await saveChatDraft(h.slayDb, 'tab-1', { text: 'x', attachments: [] })
      expect(await getChatTabState(h.slayDb, 'tab-1')).toEqual({
        draft: { text: 'x', attachments: [], rev: 1 },
        scroll: { atBottom: false, key: 'user:m1', offsetPx: 42 }
      })
      await saveChatScroll(h.slayDb, 'tab-1', { atBottom: true })
      expect((await getChatTabState(h.slayDb, 'tab-1'))?.scroll).toEqual({ atBottom: true })
    } finally {
      h.cleanup()
    }
  })

  test("a scroll anchor keeps its row (a paged history loads that row's page to restore)", async () => {
    const h = await createTestHarness()
    try {
      seedTab(h)
      await saveChatScroll(h.slayDb, 'tab-1', {
        atBottom: false,
        key: 'tool:t1',
        offsetPx: 3,
        row: 1234
      })
      expect((await getChatTabState(h.slayDb, 'tab-1'))?.scroll).toEqual({
        atBottom: false,
        key: 'tool:t1',
        offsetPx: 3,
        row: 1234
      })
    } finally {
      h.cleanup()
    }
  })

  test('a save for a tab that is gone is ignored (no throw), and the row goes with its tab', async () => {
    const h = await createTestHarness()
    try {
      seedTab(h)
      await expect(
        saveChatDraft(h.slayDb, 'gone', { text: 'x', attachments: [] })
      ).resolves.toBeNull()
      await expect(saveChatScroll(h.slayDb, 'gone', { atBottom: true })).resolves.toBeUndefined()
      await saveChatDraft(h.slayDb, 'tab-1', { text: 'x', attachments: [] })
      h.db.prepare("DELETE FROM terminal_tabs WHERE id = 'tab-1'").run()
      expect(await getChatTabState(h.slayDb, 'tab-1')).toBeNull()
    } finally {
      h.cleanup()
    }
  })

  test('corrupt JSON reads as an empty draft / no anchor', async () => {
    const h = await createTestHarness()
    try {
      seedTab(h)
      h.db
        .prepare(
          `INSERT INTO chat_tab_state (tab_id, draft_text, draft_attachments, scroll_anchor, rev, updated_at)
           VALUES ('tab-1', 'hi', '{nope', '[1,2]', 3, 1)`
        )
        .run()
      expect(await getChatTabState(h.slayDb, 'tab-1')).toEqual({
        draft: { text: 'hi', attachments: [], rev: 3 },
        scroll: null
      })
    } finally {
      h.cleanup()
    }
  })
})
