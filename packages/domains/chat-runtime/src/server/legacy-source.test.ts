import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createChatOwnershipStore } from './hub-ownership'
import { createLegacyChatSource } from './legacy-source'
import { openChatStorage } from './storage'
import { createChatTransfers } from './transfers'

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
    h.db
      .prepare(
        "INSERT INTO agent_prompts(id,task_id,agent_id,text,created_at) VALUES('prompt','task','claude-chat','private prompt',12340)"
      )
      .run()
    h.db
      .prepare(
        "INSERT INTO agent_turns(id,task_id,worktree_path,terminal_tab_id,snapshot_sha,prompt_preview,created_at) VALUES('turn','task','/project','tab','abc','private preview',12340)"
      )
      .run()
    const ownership = createChatOwnershipStore(h.slayDb),
      owner = await ownership.register({
        id: 'c',
        taskId: 'task',
        tabId: 'tab',
        mode: 'claude-chat',
        epoch: 1,
        computerId: null
      })
    const source = createLegacyChatSource({
      db: h.slayDb,
      quiesce: async () => {},
      bootstrap: async (o) => ({
        identity: { id: o.id, taskId: o.taskId, tabId: o.tabId, mode: o.mode, epoch: o.epoch + 1 },
        projectId: 'p',
        cwd: '/project',
        revision: 1,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      }),
      readAttachment: async () => new Uint8Array()
    })
    await source.quiesce(owner)
    const export1 = await source.open(owner, 'move'),
      export2 = await source.open(owner, 'move')
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
    expect(dest.read('c', -1)).toMatchObject([
      { seq: 9, at: 12345, event: { text: 'private answer' } }
    ])
    expect(dest.getRecord('c', 'draft', 'state')).toMatchObject({
      draft: { text: 'private draft', rev: 4 }
    })
    expect(dest.getRecord('c', 'prompt', 'prompt')).toMatchObject({
      text: 'private prompt',
      createdAt: 12340
    })
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
    expect(h.db.prepare('SELECT count(*) AS n FROM agent_prompts').get()).toEqual({ n: 0 })
    expect(h.db.prepare('SELECT prompt_preview FROM agent_turns').get()).toEqual({
      prompt_preview: ''
    })
    expect(await ownership.forTab('tab')).toMatchObject({ computerId: 'pc', epoch: 2 })
  } finally {
    dest.close()
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})
