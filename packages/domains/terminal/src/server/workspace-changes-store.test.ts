import { expect, it } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createWorkspaceChangesStore } from './workspace-changes-store'

it('persists diffs separately, scopes reads to their tab, and recovers incomplete captures', async () => {
  const h = await createTestHarness()
  try {
    h.db.prepare("INSERT INTO projects (id,name,color) VALUES ('p','Project','#000')").run()
    h.db.prepare("INSERT INTO tasks (id,project_id,title) VALUES ('t','p','Task')").run()
    h.db
      .prepare(
        "INSERT INTO terminal_tabs (id,task_id,mode,position) VALUES ('tab','t','codex-chat',0)"
      )
      .run()
    const store = createWorkspaceChangesStore(h.slayDb)
    const record = {
      id: 'capture',
      tabId: 'tab',
      messageId: 'message',
      computerId: 'computer',
      rootPath: '/repo',
      files: []
    }
    await store.begin({ ...record, status: 'pending' })
    const events = await store.recover('tab')
    expect(events[0]).toMatchObject({ captureId: 'capture', status: 'unavailable' })
    expect(await store.get('wrong-tab', 'capture')).toBeNull()
    await store.save({
      ...record,
      status: 'complete',
      files: [
        { path: 'new.ts', kind: 'added', additions: 1, deletions: 0, binary: false, diff: '+new' }
      ]
    })
    expect((await store.get('tab', 'capture'))?.files[0]).toMatchObject({
      hasDiff: true,
      diff: null
    })
    expect(await store.getFileDiff('tab', 'capture', 'new.ts')).toBe('+new')
    expect(await store.getFileDiff('wrong-tab', 'capture', 'new.ts')).toBeNull()
    expect(await store.recover('tab')).toEqual([])
  } finally {
    h.cleanup()
  }
})
