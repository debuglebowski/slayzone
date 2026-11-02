import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createChatFolderDeletions } from './hub-folders'
import { createChatLifecycle } from './hub-lifecycle'

test('folder fences precede commands; a failed or malformed acknowledgement remains pending', async () => {
  const h = await createTestHarness()
  try {
    const folders = createChatFolderDeletions(h.slayDb)
    await folders.record('t', ['gone'])
    const calls: string[] = []
    let answer: unknown = { ok: false }
    const lifecycle = createChatLifecycle({
      db: h.slayDb,
      request: async (_pc, raw) => {
        const p = raw as { kind: string }
        calls.push(p.kind)
        if (p.kind === 'folders.delete') return answer
        return 'command result'
      }
    })
    await lifecycle.track('t', 'pc')
    await expect(lifecycle.request('pc', { kind: 'invoke' })).rejects.toThrow(/acknowledgement/)
    expect(calls).toEqual(['folders.delete'])
    expect(h.db.prepare('SELECT * FROM chat_folder_deletion_acks').all()).toEqual([])
    answer = { ok: true }
    expect(await lifecycle.request('pc', { kind: 'invoke' })).toBe('command result')
    expect(calls).toEqual(['folders.delete', 'folders.delete', 'invoke'])
  } finally {
    h.cleanup()
  }
})

test('a newly tracked task receives older folder tombstones even after another task advanced', async () => {
  const h = await createTestHarness()
  try {
    const folders = createChatFolderDeletions(h.slayDb)
    await folders.record('first', ['one'])
    await folders.record('second', ['two'])
    const tasks: string[] = []
    const lifecycle = createChatLifecycle({
      db: h.slayDb,
      request: async (_pc, raw) => {
        tasks.push((raw as { taskId: string }).taskId)
        return { ok: true }
      }
    })
    await lifecycle.track('second', 'pc')
    await lifecycle.sync('pc')
    await lifecycle.track('first', 'pc')
    await lifecycle.sync('pc')
    expect(tasks).toEqual(['second', 'first'])
  } finally {
    h.cleanup()
  }
})

test('recovery authorizes folder inventory before deleting anything', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task'); INSERT INTO artifact_folders(id,task_id,name) VALUES('folder','t','Original')"
    )
    const folders = createChatFolderDeletions(h.slayDb)
    await expect(
      folders.recover(
        'pc',
        async () => ({
          rows: [{ sequence: 1, folderId: 'folder', taskId: 't' }],
          hasMore: false,
          nextCursor: 1
        }),
        async () => {
          throw new Error('Denied')
        }
      )
    ).rejects.toThrow('Denied')
    expect(h.db.prepare('SELECT name FROM artifact_folders').all()).toEqual([{ name: 'Original' }])
    expect(h.db.prepare('SELECT * FROM chat_folder_deletions').all()).toEqual([])
  } finally {
    h.cleanup()
  }
})

test.each([
  { rows: [], hasMore: true, nextCursor: 0 },
  { rows: [], hasMore: 'false', nextCursor: 0 },
  { rows: [{ sequence: 2, folderId: 'f', taskId: 't' }], hasMore: false, nextCursor: 1 }
])('malformed folder inventory cannot silently advance recovery: %j', async (page) => {
  const h = await createTestHarness()
  try {
    await expect(
      createChatFolderDeletions(h.slayDb).recover('pc', async () => page)
    ).rejects.toThrow(/inventory/i)
  } finally {
    h.cleanup()
  }
})
