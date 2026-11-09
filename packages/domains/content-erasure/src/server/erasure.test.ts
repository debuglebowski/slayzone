import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createTestHarness, type TestHarness } from '../../../../shared/test-utils/ipc-harness'
import { eraseContent, resumeErasure } from './index'

const fixtures: TestHarness[] = []
afterEach(() => {
  for (const h of fixtures.splice(0)) h.cleanup()
})

async function fixture() {
  const h = await createTestHarness()
  fixtures.push(h)
  const root = h.tmpDir()
  for (const owner of ['alice', 'bob']) {
    h.db
      .prepare('INSERT INTO projects(id,name,color,owner_user_id) VALUES(?,?,?,?)')
      .run(`project-${owner}`, `${owner} private project`, '#000000', owner)
    h.db
      .prepare('INSERT INTO tasks(id,project_id,title,description) VALUES(?,?,?,?)')
      .run(`task-${owner}`, `project-${owner}`, `${owner} title`, `${owner} private description`)
    h.db
      .prepare('INSERT INTO task_artifacts(id,task_id,title) VALUES(?,?,?)')
      .run(`artifact-${owner}`, `task-${owner}`, `${owner}.txt`)
    const dir = join(root, 'artifacts', `task-${owner}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `artifact-${owner}.txt`), `${owner} original`)
  }
  function version(owner: string, bytes: string, number = 1) {
    const hash = createHash('sha256').update(bytes).digest('hex')
    const path = join(root, 'blobs', hash.slice(0, 2), hash.slice(2))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bytes)
    h.db
      .prepare('INSERT OR IGNORE INTO artifact_blobs(hash,size) VALUES(?,?)')
      .run(hash, bytes.length)
    h.db
      .prepare(
        'INSERT INTO artifact_versions(id,artifact_id,version_num,content_hash,size,name) VALUES(?,?,?,?,?,?)'
      )
      .run(
        `${owner}-v${number}`,
        `artifact-${owner}`,
        number,
        hash,
        bytes.length,
        `named-${number}`
      )
    return { hash, path }
  }
  return { h, root, version }
}

test('erases projects, archived tasks, originals, legacy files and every named version; preserves another owner', async () => {
  const { h, root, version } = await fixture()
  const a = version('alice', 'alice historical secret')
  const b = version('bob', 'bob retained history')
  h.db.prepare("UPDATE tasks SET archived_at=datetime('now') WHERE id='task-alice'").run()
  mkdirSync(join(root, 'assets', 'task-alice'), { recursive: true })
  writeFileSync(join(root, 'assets', 'task-alice', 'old.txt'), 'alice legacy secret')
  const report = await eraseContent(h.slayDb, root, { kind: 'user', userId: 'alice' })
  expect(report.state).toBe('complete')
  expect(h.db.prepare("SELECT 1 FROM projects WHERE id='project-alice'").get()).toBeUndefined()
  expect(existsSync(join(root, 'artifacts', 'task-alice'))).toBe(false)
  expect(existsSync(join(root, 'assets', 'task-alice'))).toBe(false)
  expect(existsSync(a.path)).toBe(false)
  expect(readFileSync(b.path, 'utf8')).toBe('bob retained history')
  expect(h.db.prepare("SELECT title FROM tasks WHERE id='task-bob'").get()).toEqual({
    title: 'bob title'
  })
  expect(h.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  const metadata = JSON.stringify(h.db.prepare('SELECT * FROM content_erasure_jobs').all())
  expect(metadata).not.toContain('alice historical secret')
  expect(metadata).not.toContain('alice private description')
  expect(metadata).not.toContain('alice.txt')
})

test('shared hashes and independently owned backup pins survive source erasure', async () => {
  const { h, root, version } = await fixture()
  const shared = version('alice', 'shared bytes')
  version('bob', 'shared bytes')
  const backup = version('alice', 'kept only for an old backup', 2)
  h.db
    .prepare('INSERT INTO artifact_blob_pins VALUES(?,?,?,?,?,?,?,?,?)')
    .run(
      'hub-backup',
      'snapshot-id',
      'pin',
      'ref',
      'task-alice',
      'artifact-alice',
      1,
      backup.hash,
      26
    )
  const report = await eraseContent(h.slayDb, root, { kind: 'user', userId: 'alice' })
  expect(report.state).toBe('complete')
  expect(report.retainedSharedBlobs).toBe(1)
  expect(report.retainedBackupBlobs).toBe(1)
  expect(existsSync(shared.path)).toBe(true)
  expect(existsSync(backup.path)).toBe(true)
  expect(
    h.db.prepare("SELECT 1 FROM artifact_versions WHERE artifact_id='artifact-bob'").get()
  ).toBeDefined()
})

test('a filesystem failure stays visible and resumes after database rows have already gone', async () => {
  const { h, root, version } = await fixture()
  const a = version('alice', 'alice bytes')
  const report = await eraseContent(
    h.slayDb,
    root,
    { kind: 'user', userId: 'alice' },
    {
      removePath: () => {
        throw new Error('a private path must never reach the report')
      }
    }
  )
  expect(report.state).toBe('incomplete')
  expect(report.failures).toContain('LOCAL_FILES_NOT_DELETED')
  expect(JSON.stringify(report)).not.toContain('a private path')
  expect(h.db.prepare("SELECT 1 FROM tasks WHERE id='task-alice'").get()).toBeUndefined()
  const resumed = await resumeErasure(h.slayDb, root, report.id)
  expect(resumed.state).toBe('complete')
  expect(existsSync(a.path)).toBe(false)
})

test('an outstanding blob lease defers cleanup; retry erases current and rollback blob links', async () => {
  const { h, root, version } = await fixture()
  const a = version('alice', 'old rollback bytes')
  mkdirSync(join(root, 'blobs', '.gc'), { recursive: true })
  const rollback = join(root, 'blobs', '.gc', a.hash)
  writeFileSync(rollback, 'old rollback bytes')
  h.db
    .prepare('INSERT INTO artifact_blob_leases VALUES(?,?)')
    .run('in-flight-backup', Date.now() + 60000)
  const report = await eraseContent(h.slayDb, root, { kind: 'user', userId: 'alice' })
  expect(report.state).toBe('incomplete')
  expect(existsSync(a.path)).toBe(true)
  h.db.prepare('DELETE FROM artifact_blob_leases').run()
  const resumed = await resumeErasure(h.slayDb, root, report.id)
  expect(resumed.state).toBe('complete')
  expect(existsSync(a.path)).toBe(false)
  expect(existsSync(rollback)).toBe(false)
})

test('offline computer copies are named and never reported erased', async () => {
  const { h, root } = await fixture()
  h.db
    .prepare(
      'INSERT INTO computers(id,name,platform,version,capabilities_json,created_at,owner_user_id) VALUES(?,?,?,?,?,?,?)'
    )
    .run('computer-alice', 'Alice laptop', 'darwin', 'fixture', '[]', Date.now(), 'alice')
  h.db.prepare('INSERT INTO chat_task_computers VALUES(?,?)').run('task-alice', 'computer-alice')
  const report = await eraseContent(h.slayDb, root, { kind: 'user', userId: 'alice' })
  expect(report.state).toBe('incomplete')
  expect(report.computers).toEqual([{ id: 'computer-alice', name: 'Alice laptop', deleted: false }])
  expect(h.db.prepare("SELECT 1 FROM tasks WHERE id='task-bob'").get()).toBeDefined()
})

test('a legacy cross-owner parent link cannot cascade deletion into another user', async () => {
  const { h, root } = await fixture()
  h.db.prepare("UPDATE tasks SET parent_id='task-alice' WHERE id='task-bob'").run()
  await eraseContent(h.slayDb, root, { kind: 'user', userId: 'alice' })
  expect(h.db.prepare("SELECT title,parent_id FROM tasks WHERE id='task-bob'").get()).toEqual({
    title: 'bob title',
    parent_id: null
  })
  expect(existsSync(join(root, 'artifacts', 'task-bob', 'artifact-bob.txt'))).toBe(true)
})

test('manual re-erasure also removes historical files restored after their database rows were erased', async () => {
  const { h, root, version } = await fixture()
  const old = version('alice', 'alice restored historical bytes')
  await eraseContent(h.slayDb, root, { kind: 'user', userId: 'alice' })
  mkdirSync(join(root, 'artifacts', 'task-alice'), { recursive: true })
  writeFileSync(join(root, 'artifacts', 'task-alice', 'artifact-alice.txt'), 'restored original')
  mkdirSync(dirname(old.path), { recursive: true })
  writeFileSync(old.path, 'alice restored historical bytes')
  const reapplied = await eraseContent(h.slayDb, root, { kind: 'user', userId: 'alice' })
  expect(reapplied.state).toBe('complete')
  expect(existsSync(join(root, 'artifacts', 'task-alice'))).toBe(false)
  expect(existsSync(old.path)).toBe(false)
  expect(h.db.prepare("SELECT 1 FROM tasks WHERE id='task-bob'").get()).toBeDefined()
})

test('account erasure retries an earlier failed item deletion before reporting completion', async () => {
  const { h, root, version } = await fixture()
  const old = version('alice', 'old item bytes')
  const item = await eraseContent(
    h.slayDb,
    root,
    { kind: 'artifacts', ids: ['artifact-alice'] },
    {
      removePath() {
        throw new Error('disk failure')
      }
    }
  )
  expect(item.state).toBe('incomplete')
  const account = await eraseContent(h.slayDb, root, { kind: 'user', userId: 'alice' })
  expect(account.state).toBe('complete')
  expect(h.db.prepare('SELECT state FROM content_erasure_jobs WHERE id=?').get(item.id)).toEqual({
    state: 'complete'
  })
  expect(existsSync(old.path)).toBe(false)
})

test('a bulk request containing a previously deleted task still erases newly selected tasks', async () => {
  const { h, root } = await fixture()
  h.db
    .prepare(
      "INSERT INTO tasks(id,project_id,title) VALUES('task-alice-2','project-alice','second')"
    )
    .run()
  await eraseContent(h.slayDb, root, { kind: 'tasks', ids: ['task-alice'] })
  const report = await eraseContent(h.slayDb, root, {
    kind: 'tasks',
    ids: ['task-alice', 'task-alice-2']
  })
  expect(report.state).toBe('complete')
  expect(h.db.prepare("SELECT 1 FROM tasks WHERE id='task-alice-2'").get()).toBeUndefined()
})

test('late content writes cannot recreate erased content', async () => {
  const { h, root } = await fixture()
  await eraseContent(h.slayDb, root, { kind: 'tasks', ids: ['task-alice'] })
  expect(() =>
    h.db
      .prepare(
        "INSERT INTO activity_events(id,entity_type,entity_id,task_id,kind,actor_type,source,summary) VALUES('late','task','task-alice','task-alice','task.updated','system','test','private late output')"
      )
      .run()
  ).toThrow(/permanently erased/)
})

test('unattributed legacy files stay untouched and prevent a misleading all-content completion', async () => {
  const { h, root } = await fixture()
  const unknown = join(root, 'artifacts', 'legacy-orphan')
  mkdirSync(unknown, { recursive: true })
  writeFileSync(join(unknown, 'file.txt'), 'could belong to another user')
  const report = await eraseContent(h.slayDb, root, { kind: 'user', userId: 'alice' })
  expect(report.state).toBe('incomplete')
  expect(report.failures).toContain('LEGACY_FILES_NEED_OWNERSHIP_REVIEW')
  expect(readFileSync(join(unknown, 'file.txt'), 'utf8')).toBe('could belong to another user')
})

test('a delayed import cannot recreate a permanently erased artifact in a live task', async () => {
  const { h, root } = await fixture()
  await eraseContent(h.slayDb, root, { kind: 'artifacts', ids: ['artifact-alice'] })
  expect(() =>
    h.db
      .prepare(
        "INSERT INTO task_artifacts(id,task_id,title) VALUES('artifact-alice','task-alice','late private content')"
      )
      .run()
  ).toThrow(/permanently erased/)
})

test('legacy cross-owner folder links and shared conversation references preserve the other owner', async () => {
  const { h, root } = await fixture()
  h.db
    .prepare(
      "INSERT INTO artifact_folders(id,task_id,name) VALUES('fa','task-alice','Alice folder')"
    )
    .run()
  h.db
    .prepare(
      "INSERT INTO artifact_folders(id,task_id,name,parent_id) VALUES('fb','task-bob','Bob folder','fa')"
    )
    .run()
  for (const user of ['alice', 'bob'])
    h.db
      .prepare(
        "INSERT INTO task_conversations(id,task_id,mode,conversation_id,origin,created_at) VALUES(?,?,?,'shared-conversation','user-selected',1)"
      )
      .run('ledger-' + user, 'task-' + user, 'claude-code')
  h.db.prepare("INSERT INTO session_turns VALUES('shared-conversation',1)").run()
  await eraseContent(h.slayDb, root, { kind: 'user', userId: 'alice' })
  expect(h.db.prepare("SELECT name,parent_id FROM artifact_folders WHERE id='fb'").get()).toEqual({
    name: 'Bob folder',
    parent_id: null
  })
  expect(
    h.db
      .prepare(
        "SELECT first_turn_at FROM session_turns WHERE conversation_id='shared-conversation'"
      )
      .get()
  ).toEqual({ first_turn_at: 1 })
})

test('cached references lose deleted titles without deleting another user’s layout or preferences', async () => {
  const { h, root } = await fixture()
  h.db.prepare("INSERT INTO user_settings(user_id,key,value) VALUES('bob','viewState',?)").run(
    JSON.stringify({
      tabs: [
        { taskId: 'task-alice', title: 'Alice cached secret' },
        { taskId: 'task-bob', title: 'Bob cached title' }
      ],
      sidebarWidth: 270
    })
  )
  h.db
    .prepare(
      "INSERT INTO settings(key,value) VALUES('ai_providers:project-alice','private provider config')"
    )
    .run()
  await eraseContent(h.slayDb, root, { kind: 'user', userId: 'alice' })
  const cache = h.db
    .prepare("SELECT value FROM user_settings WHERE user_id='bob' AND key='viewState'")
    .get() as { value: string }
  expect(JSON.parse(cache.value)).toEqual({
    tabs: [{ taskId: 'task-bob', title: 'Bob cached title' }],
    sidebarWidth: 270
  })
  expect(
    h.db.prepare("SELECT value FROM settings WHERE key='ai_providers:project-alice'").get()
  ).toBeUndefined()
})

test('a diagnostic cleanup failure does not prevent erasing known task files', async () => {
  const { h, root } = await fixture()
  const report = await eraseContent(
    h.slayDb,
    root,
    { kind: 'user', userId: 'alice' },
    {
      cleanupAdditionalStores: async () => {
        throw new Error('LEGACY_DIAGNOSTICS_NEED_OWNERSHIP_REVIEW')
      }
    }
  )
  expect(report.state).toBe('incomplete')
  expect(report.failures).toContain('LEGACY_DIAGNOSTICS_NEED_OWNERSHIP_REVIEW')
  expect(existsSync(join(root, 'artifacts', 'task-alice'))).toBe(false)
  expect(existsSync(join(root, 'artifacts', 'task-bob'))).toBe(true)
})

test('a sealed legacy chat attachment remains owned by its other user after the original version disappears', async () => {
  const { h, root, version } = await fixture()
  const blob = version('alice', 'legacy shared attachment')
  h.db
    .prepare(
      "INSERT INTO chat_attachment_messages(task_id,message_id,attachments) VALUES('task-bob','message',?)"
    )
    .run(JSON.stringify([{ artifactId: 'legacy-file', contentHash: blob.hash }]))
  const report = await eraseContent(h.slayDb, root, { kind: 'user', userId: 'alice' })
  expect(report.state).toBe('complete')
  expect(report.retainedSharedBlobs).toBe(1)
  expect(readFileSync(blob.path, 'utf8')).toBe('legacy shared attachment')
})

test('unattributed blob staging cannot be silently counted as erased', async () => {
  const { h, root } = await fixture()
  const stage = join(root, 'blobs', '.tmp')
  mkdirSync(stage, { recursive: true })
  writeFileSync(join(stage, 'abandoned-write'), 'unknown owner bytes')
  const report = await eraseContent(h.slayDb, root, { kind: 'user', userId: 'alice' })
  expect(report.state).toBe('incomplete')
  expect(report.failures).toContain('LEGACY_FILES_NEED_OWNERSHIP_REVIEW')
  expect(existsSync(join(stage, 'abandoned-write'))).toBe(true)
})

// --- Subtasks: deleting a task erases only what was selected --------------------

function insertTask(h: TestHarness, id: string, parentId: string | null, extra = '') {
  h.db
    .prepare(
      `INSERT INTO tasks(id,project_id,title,parent_id${extra ? ',' + extra : ''}) VALUES(?,?,?,?${extra ? ',?' : ''})`
    )
    .run(id, 'project-alice', `${id} title`, parentId, ...(extra ? ['/wt/shared'] : []))
}
const parentOf = (h: TestHarness, id: string) =>
  (
    h.db.prepare('SELECT parent_id FROM tasks WHERE id=?').get(id) as
      | { parent_id: string | null }
      | undefined
  )?.parent_id

test('deleting a parent task keeps its subtasks, re-parented to the nearest surviving ancestor', async () => {
  const { h, root } = await fixture()
  insertTask(h, 'grand', null)
  insertTask(h, 'parent', 'grand')
  insertTask(h, 'child', 'parent')
  insertTask(h, 'grandchild', 'child')
  h.db
    .prepare(
      "INSERT INTO task_artifacts(id,task_id,title) VALUES('artifact-child','child','c.txt')"
    )
    .run()
  mkdirSync(join(root, 'artifacts', 'child'), { recursive: true })
  writeFileSync(join(root, 'artifacts', 'child', 'artifact-child.txt'), 'child original')
  const report = await eraseContent(h.slayDb, root, { kind: 'tasks', ids: ['parent'] })
  expect(report.state).toBe('complete')
  expect(report.counts.tasks).toBe(1)
  expect(parentOf(h, 'parent')).toBeUndefined()
  expect(parentOf(h, 'child')).toBe('grand')
  expect(parentOf(h, 'grandchild')).toBe('child')
  expect(h.db.prepare("SELECT deleted_at FROM tasks WHERE id='child'").get()).toEqual({
    deleted_at: null
  })
  expect(readFileSync(join(root, 'artifacts', 'child', 'artifact-child.txt'), 'utf8')).toBe(
    'child original'
  )
  expect(h.db.prepare("SELECT 1 FROM task_artifacts WHERE id='artifact-child'").get()).toBeDefined()
})

test('a deleted top-level task leaves its subtasks top-level', async () => {
  const { h, root } = await fixture()
  insertTask(h, 'parent', null)
  insertTask(h, 'child', 'parent')
  await eraseContent(h.slayDb, root, { kind: 'tasks', ids: ['parent'] })
  expect(parentOf(h, 'child')).toBeNull()
})

test('a bulk delete selecting a parent and its subtask erases both; unselected descendants skip erased ancestors', async () => {
  const { h, root } = await fixture()
  insertTask(h, 'grand', null)
  insertTask(h, 'parent', 'grand')
  insertTask(h, 'child', 'parent')
  insertTask(h, 'grandchild', 'child')
  insertTask(h, 'sibling', 'parent')
  const report = await eraseContent(h.slayDb, root, { kind: 'tasks', ids: ['parent', 'child'] })
  expect(report.counts.tasks).toBe(2)
  expect(parentOf(h, 'parent')).toBeUndefined()
  expect(parentOf(h, 'child')).toBeUndefined()
  expect(parentOf(h, 'grandchild')).toBe('grand')
  expect(parentOf(h, 'sibling')).toBe('grand')
})

test('project erasure still erases every task in the project, subtasks included', async () => {
  const { h, root } = await fixture()
  insertTask(h, 'parent', null)
  insertTask(h, 'child', 'parent')
  await eraseContent(h.slayDb, root, { kind: 'projects', ids: ['project-alice'] })
  for (const id of ['parent', 'child', 'task-alice']) expect(parentOf(h, id)).toBeUndefined()
  expect(parentOf(h, 'task-bob')).toBeNull()
})

test('a surviving subtask keeps the worktree it shares with its deleted parent', async () => {
  const { h, root } = await fixture()
  insertTask(h, 'parent', null, 'worktree_path')
  insertTask(h, 'child', 'parent', 'worktree_path')
  const cleaned: string[] = []
  const report = await eraseContent(
    h.slayDb,
    root,
    { kind: 'tasks', ids: ['parent'] },
    {
      cleanupWorktree: async (target) => {
        cleaned.push(target.path)
      }
    }
  )
  expect(report.state).toBe('complete')
  expect(cleaned).toEqual([])
  expect(h.db.prepare("SELECT worktree_path FROM tasks WHERE id='child'").get()).toEqual({
    worktree_path: '/wt/shared'
  })
})

// --- Worktree location: recorded, else the task's computer, else the hub default ---

function computer(h: TestHarness, id: string, revokedAt: number | null = null) {
  h.db
    .prepare(
      'INSERT INTO computers(id,name,platform,version,capabilities_json,created_at,owner_user_id,revoked_at) VALUES(?,?,?,?,?,?,?,?)'
    )
    .run(id, `${id} name`, 'darwin', 'fixture', '[]', Date.now(), 'alice', revokedAt)
  h.db
    .prepare(
      "INSERT INTO project_placements(computer_id,project_id,root_path,status,updated_at) VALUES(?,'project-alice',?,'ready',1)"
    )
    .run(id, `/repo/on-${id}`)
}
function ackAll(h: TestHarness) {
  return async (request: { taskIds: string[] }) =>
    request.taskIds.map((taskId) => ({
      taskId,
      revision: (
        h.db.prepare('SELECT revision FROM chat_task_lifecycle WHERE task_id=?').get(taskId) as {
          revision: number
        }
      ).revision,
      erased: true as const
    }))
}

test('an unbound worktree resolves through the project computer and its placement', async () => {
  const { h, root } = await fixture()
  computer(h, 'pc')
  h.db.prepare("UPDATE projects SET default_computer_id='pc' WHERE id='project-alice'").run()
  h.db.prepare("UPDATE tasks SET worktree_path='/wt/a' WHERE id='task-alice'").run()
  const removed: unknown[] = []
  const report = await eraseContent(
    h.slayDb,
    root,
    { kind: 'tasks', ids: ['task-alice'] },
    {
      cleanupComputer: ackAll(h),
      cleanupWorktree: async (t) => {
        removed.push({ computerId: t.computerId, repoPath: t.repoPath, path: t.path })
      }
    }
  )
  expect(removed).toEqual([{ computerId: 'pc', repoPath: '/repo/on-pc', path: '/wt/a' }])
  expect(report.state).toBe('complete')
})

test('an unbound worktree resolves to the hub default once, durably, and waits while none is connected', async () => {
  const { h, root } = await fixture()
  computer(h, 'first')
  computer(h, 'second')
  h.db.prepare("UPDATE tasks SET worktree_path='/wt/a' WHERE id='task-alice'").run()
  const picks: Array<string | null> = [null, 'first', 'second']
  const asked: unknown[] = [],
    removed: unknown[] = []
  const options = {
    cleanupComputer: ackAll(h),
    resolveWorktreeComputer: async (target: unknown) => {
      asked.push(target)
      const computerId = picks.shift() ?? null
      return computerId ? { computerId } : { computerId: null, gone: false }
    },
    cleanupWorktree: async (t: { computerId: string | null; repoPath: string | null }) => {
      removed.push({ computerId: t.computerId, repoPath: t.repoPath })
      if (removed.length === 1) throw new Error('computer busy')
    }
  }
  const waiting = await eraseContent(
    h.slayDb,
    root,
    { kind: 'tasks', ids: ['task-alice'] },
    options
  )
  expect(waiting.state).toBe('incomplete')
  expect(waiting.failures).toContain('WORKTREE_COMPUTER_UNAVAILABLE')
  expect(removed).toEqual([])
  expect(asked).toEqual([
    { taskId: 'task-alice', projectId: 'project-alice', ownerUserId: 'alice' }
  ])
  // The default connects: resolved after the task row is gone, from durable state.
  const failed = await resumeErasure(h.slayDb, root, waiting.id, options)
  expect(failed.state).toBe('incomplete')
  expect(failed.computers).toContainEqual(expect.objectContaining({ id: 'first', deleted: false }))
  // A later retry keeps the resolved computer even though the default changed.
  const done = await resumeErasure(h.slayDb, root, waiting.id, options)
  expect(done.state).toBe('complete')
  expect(removed).toEqual([
    { computerId: 'first', repoPath: '/repo/on-first' },
    { computerId: 'first', repoPath: '/repo/on-first' }
  ])
  expect(asked).toHaveLength(2)
})

test('a revoked worktree computer is reported clearly and never retried automatically', async () => {
  const { h, root } = await fixture()
  computer(h, 'gone', 5)
  h.db
    .prepare(
      "UPDATE tasks SET worktree_path='/wt/a',worktree_computer_id='gone' WHERE id='task-alice'"
    )
    .run()
  let attempts = 0
  const options = {
    cleanupComputer: async () => {
      throw new Error('COMPUTER_UNAVAILABLE')
    },
    cleanupWorktree: async () => {
      attempts++
    }
  }
  const report = await eraseContent(h.slayDb, root, { kind: 'tasks', ids: ['task-alice'] }, options)
  expect(report.state).toBe('incomplete')
  expect(report.failures).toContain('WORKTREE_COMPUTER_GONE')
  expect(report.computers).toContainEqual(expect.objectContaining({ id: 'gone', deleted: false }))
  const again = await resumeErasure(h.slayDb, root, report.id, options)
  expect(again.failures).toContain('WORKTREE_COMPUTER_GONE')
  expect(attempts).toBe(0)
})

test('no computer that could ever hold an unbound worktree: reported gone, not retried', async () => {
  const { h, root } = await fixture()
  h.db.prepare("UPDATE tasks SET worktree_path='/wt/a' WHERE id='task-alice'").run()
  let asked = 0
  const options = {
    resolveWorktreeComputer: async () => {
      asked++
      return { computerId: null, gone: true }
    },
    cleanupWorktree: async () => {
      throw new Error('must not be called')
    }
  }
  const report = await eraseContent(h.slayDb, root, { kind: 'tasks', ids: ['task-alice'] }, options)
  expect(report.failures).toContain('WORKTREE_COMPUTER_GONE')
  await resumeErasure(h.slayDb, root, report.id, options)
  expect(asked).toBe(1)
})

test('a live task sharing the path keeps the worktree even when only the deleted task recorded its computer', async () => {
  const { h, root } = await fixture()
  computer(h, 'pc')
  h.db
    .prepare(
      "UPDATE tasks SET worktree_path='/wt/s',worktree_computer_id='pc' WHERE id='task-alice'"
    )
    .run()
  insertTask(h, 'other', null, 'worktree_path')
  h.db.prepare("UPDATE tasks SET worktree_path='/wt/s' WHERE id='other'").run()
  const removed: string[] = []
  await eraseContent(
    h.slayDb,
    root,
    { kind: 'tasks', ids: ['task-alice'] },
    {
      cleanupComputer: ackAll(h),
      cleanupWorktree: async (t) => {
        removed.push(t.path)
      }
    }
  )
  expect(removed).toEqual([])
})
