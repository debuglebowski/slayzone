import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createArtifactStore } from './artifact-store'
test('normal artifact deletion erases version bytes and preserves its live task', async () => {
  const h = await createTestHarness(),
    root = h.tmpDir()
  try {
    h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
    h.db.prepare("INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task')").run()
    h.db.prepare("INSERT INTO task_artifacts(id,task_id,title) VALUES('a','t','private.txt')").run()
    const hash = createHash('sha256').update('private saved version').digest('hex'),
      path = join(root, 'blobs', hash.slice(0, 2), hash.slice(2))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'private saved version')
    h.db
      .prepare(
        'INSERT INTO artifact_versions(id,artifact_id,version_num,content_hash,size) VALUES(?,?,?,?,?)'
      )
      .run('v', 'a', 1, hash, 21)
    await createArtifactStore(root).deleteArtifact(h.slayDb, 'a')
    expect(existsSync(path)).toBe(false)
    expect(h.db.prepare("SELECT 1 FROM tasks WHERE id='t'").get()).toBeDefined()
  } finally {
    h.cleanup()
  }
})
