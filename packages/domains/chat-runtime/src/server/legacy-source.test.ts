import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createChatOwnershipStore } from './hub-ownership'
import { createLegacyChatSource } from './legacy-source'
import { openChatStorage } from './storage'
import { createChatTransfers } from './transfers'

test('legacy migration preserves opaque attachment-shaped tool payloads in events and timeline projections', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','Project','#000'); INSERT INTO tasks(id,project_id,title) VALUES('task','p','Task'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
    )
    const metadata = {
      artifactId: 'external-object',
      name: 'tool.txt',
      kind: 'text',
      mediaType: 'text/plain',
      size: 7
    }
    const event = {
      kind: 'tool-result',
      toolUseId: 'call',
      isError: false,
      rawContent: metadata,
      structured: { nested: metadata }
    }
    h.db
      .prepare("INSERT INTO chat_events(tab_id,seq,event,saved_at) VALUES('tab',0,?,123)")
      .run(JSON.stringify(event))
    const row = {
      kind: 'tool',
      invocation: {
        id: 'call',
        name: 'external',
        input: metadata,
        status: 'done',
        result: { rawContent: metadata }
      },
      timestamp: 123
    }
    const rows = JSON.stringify([row]),
      data = JSON.stringify({
        v: '10',
        rowCount: 1,
        tailFrom: 0,
        tail: [row],
        state: { arbitrary: metadata }
      })
    h.db
      .prepare(
        "INSERT INTO chat_timeline_pages(tab_id,page,start_row,end_row,rows,summary,search_text) VALUES('tab',0,0,0,?,'{}','')"
      )
      .run(rows)
    h.db
      .prepare(
        "INSERT INTO chat_timeline_checkpoints(tab_id,version,seq,data,updated_at) VALUES('tab','10.1',0,?,123)"
      )
      .run(data)
    const ownership = createChatOwnershipStore(h.slayDb)
    const owner = await ownership.register({
      id: 'store',
      taskId: 'task',
      tabId: 'tab',
      mode: 'claude-chat',
      epoch: 1,
      computerId: null
    })
    const source = createLegacyChatSource({
      db: h.slayDb,
      quiesce: async () => {},
      bootstrap: async () => ({
        identity: { id: 'store', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 2 },
        projectId: 'p',
        cwd: '/tmp',
        revision: 0,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      }),
      readAttachment: async () => {
        throw new Error('Tool metadata is not a chat attachment')
      }
    })
    const exported = await source.open(owner, 'move')
    const chunks: Uint8Array[] = []
    for await (const chunk of exported.chunks(0)) chunks.push(chunk)
    const items = Buffer.concat(chunks)
      .toString()
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => JSON.parse(line))
    expect(items.find((item) => item.kind === 'event').value.event).toEqual(event)
    expect(
      items.find(
        (item) =>
          item.kind === 'record' && item.value.kind === 'timeline' && item.value.id === 'page:0'
      ).value.value.rows
    ).toBe(rows)
    expect(
      items.find(
        (item) =>
          item.kind === 'record' && item.value.kind === 'timeline' && item.value.id === 'checkpoint'
      ).value.value.data
    ).toBe(data)
    expect(items.some((item) => item.kind === 'record' && item.value.kind === 'attachment')).toBe(
      false
    )
  } finally {
    h.cleanup()
  }
})

test('legacy export preserves content and timestamps; cleanup leaves metadata only', async () => {
  const h = await createTestHarness(),
    dir = mkdtempSync(join(tmpdir(), 'chat-legacy-'))
  const dest = openChatStorage({ stateDir: dir, hubScope: 'hub' })
  try {
    h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
    h.db.prepare("INSERT INTO tasks(id,project_id,title) VALUES('task','p','Task')").run()
    h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
      )
      .run()
    h.db
      .prepare("INSERT INTO chat_events(tab_id,seq,event,saved_at) VALUES('tab',9,?,12345)")
      .run(JSON.stringify({ kind: 'assistant-text', messageId: 'm', text: 'private answer' }))
    h.db
      .prepare(
        "INSERT INTO chat_tab_state(tab_id,draft_text,rev,updated_at) VALUES('tab','private draft',4,12346)"
      )
      .run()
    // Task-wide legacy content (prompts and turns are handed off since v207).
    h.db
      .prepare(
        "INSERT INTO chat_attachment_messages(task_id,message_id,attachments) VALUES('task','message','[]')"
      )
      .run()
    // Session history is not part of the chat export: the task's session ledger
    // reaches its computer through the handoff (robustness plan §9).
    h.db
      .prepare(
        "INSERT INTO session_resets(id,task_id,mode,created_at) VALUES('reset','task','claude-chat',3)"
      )
      .run()
    h.db
      .prepare(
        "INSERT INTO chat_events(tab_id,seq,event,created_at) VALUES('tab',10,?,'2026-01-01T12:00:00Z')"
      )
      .run(JSON.stringify({ kind: 'notice', text: 'timestamp' }))
    const ownership = createChatOwnershipStore(h.slayDb),
      owner = await ownership.register({
        id: 'c',
        taskId: 'task',
        tabId: 'tab',
        mode: 'claude-chat',
        epoch: 1,
        computerId: null
      })
    let model = 'old',
      checkpoint: import('../shared').ChatRecord[] | null = null
    const source = createLegacyChatSource({
      freezeMetadata: async (_o, _id, value) => {
        if (!checkpoint && value) checkpoint = structuredClone(value)
        return checkpoint
      },
      db: h.slayDb,
      quiesce: async () => {},
      bootstrap: async (o) => ({
        identity: { id: o.id, taskId: o.taskId, tabId: o.tabId, mode: o.mode, epoch: o.epoch + 1 },
        projectId: 'p',
        cwd: '/project',
        revision: 1,
        providerConfig: { chatModel: model },
        defaultFlags: null,
        env: {}
      }),
      readAttachment: async () => new Uint8Array()
    })
    await source.quiesce(owner)
    const export1 = await source.open(owner, 'move')
    model = 'new'
    const export2 = await source.open(owner, 'move')
    expect(export1.manifest).toEqual(export2.manifest)
    const transfers = createChatTransfers(dest),
      start = transfers.begin(export1.manifest)
    let offset = 0
    for await (const bytes of export1.chunks(0)) {
      expect(bytes.length).toBeLessThanOrEqual(256 * 1024)
      transfers.chunk(start.id, offset, bytes)
      offset += bytes.length
    }
    transfers.finish(start.id)
    dest.activate('c', 'move', 2, export1.manifest.hash)
    expect(dest.read('c', -1).slice(0, 1)).toMatchObject([
      { seq: 9, at: 12345, event: { text: 'private answer' } }
    ])
    expect(dest.getRecord('c', 'draft', 'state')).toMatchObject({
      draft: { text: 'private draft', rev: 4 }
    })
    expect(dest.getRecord('c', 'settings', 'attachment-message:message')).toEqual([])
    expect(dest.read('c', 9)[0].at).toBe(Date.parse('2026-01-01T12:00:00Z'))
    expect(
      dest.findRecords('settings').filter((r) => r.id.startsWith('session:')),
      'no session records: the ledger is handed off, the resets are delivered intents'
    ).toEqual([])
    // Source cleanup itself requires a committed receipt, even if called incorrectly.
    await expect(source.cleanup(owner)).rejects.toThrow(/committed/i)
    await ownership.beginMigration('c', {
      expectedComputerId: null,
      expectedEpoch: 1,
      migrationId: 'move',
      destinationComputerId: 'pc'
    })
    await ownership.markVerified('c', 'move', export1.manifest.hash)
    const committed = await ownership.commitMigration('c', 'move', export1.manifest.hash)
    await source.cleanup(committed)
    expect(h.db.prepare('SELECT count(*) AS n FROM chat_events').get()).toEqual({ n: 0 })
    expect(h.db.prepare('SELECT count(*) AS n FROM chat_tab_state').get()).toEqual({ n: 0 })
    expect(h.db.prepare('SELECT count(*) AS n FROM chat_attachment_messages').get()).toEqual({
      n: 0
    })
    expect(await ownership.forTab('tab')).toMatchObject({ computerId: 'pc', epoch: 2 })
  } finally {
    dest.close()
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})
