import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createComputerChatRuntime } from './computer-runtime'

// Review-only probes: temporary state, real SQLite, no provider processes.
// Red assertions state required durability/privacy invariants.
const roots: string[] = []
const runtimes: ReturnType<typeof createComputerChatRuntime>[] = []
const filesIdentity = {
  id: 'files',
  taskId: 'task',
  tabId: 'artifact-store:task:pc',
  mode: 'claude-chat',
  epoch: 1
}
function runtime(root = mkdtempSync(join(realpathSync(tmpdir()), 'review-storage-durability-'))) {
  if (!roots.includes(root)) roots.push(root)
  const r = createComputerChatRuntime({ stateDir: root, hubScope: 'review', computerId: 'pc' })
  runtimes.push(r)
  for (const identity of [filesIdentity, { ...filesIdentity, id: 'chat', tabId: 'tab' }]) {
    if (r.storage.taskLifecycle(identity.taskId).state === 'deleted') continue
    r.bootstrap({
      identity,
      projectId: null,
      cwd: root,
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    })
  }
  return r
}
afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  for (const r of runtimes.splice(0)) await r.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('review: committed purge intent survives cleanup and startup IO failures, then deleted-task replay finishes it', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'review-storage-durability-')),
    r = runtime(root),
    route = { id: filesIdentity.id, epoch: 1 }
  const artifact = (await r.artifacts.invoke({
    route,
    method: 'uploadArtifactBlob',
    operationId: randomUUID(),
    args: [
      {
        taskId: 'task',
        title: 'original.txt',
        data: Buffer.from('only working copy').toString('base64')
      }
    ]
  })) as { id: string }
  const path = (await r.artifacts.store.getArtifactPath(r.artifacts.db, artifact.id))!
  const originalRm = fs.rmSync.bind(fs)
  const fault = vi.spyOn(fs, 'rmSync').mockImplementation((target, opts) => {
    if (String(target) === dirname(path))
      throw Object.assign(new Error('review cleanup IO failure'), { code: 'EIO' })
    return originalRm(target, opts)
  })
  syncBuiltinESMExports()
  await expect(r.applyTaskLifecycle('task', 'deleted', 1)).rejects.toThrow(
    'review cleanup IO failure'
  )
  expect(r.storage.taskLifecycle('task').state).toBe('deleted')
  expect(r.storage.pendingTaskCleanup()).toEqual(['task'])
  expect(existsSync(path)).toBe(true)
  await r.close()
  const next = runtime(root) // Startup cannot clean, but must still open healthy storage.
  expect(next.storage.taskLifecycle('task').state).toBe('deleted')
  expect(next.storage.pendingTaskCleanup()).toEqual(['task'])
  expect(existsSync(path)).toBe(true)
  fault.mockRestore()
  syncBuiltinESMExports()
  await expect(next.applyTaskLifecycle('task', 'deleted', 1)).resolves.toMatchObject({
    state: 'deleted'
  })
  expect(next.storage.pendingTaskCleanup()).toEqual([])
  expect(existsSync(path)).toBe(false)
})

test('review: startup completes a committed cleanup intent left before filesystem removal', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'review-storage-durability-')),
    r = runtime(root),
    route = { id: filesIdentity.id, epoch: 1 }
  const artifact = (await r.artifacts.invoke({
    route,
    method: 'uploadArtifactBlob',
    operationId: randomUUID(),
    args: [
      {
        taskId: 'task',
        title: 'original.txt',
        data: Buffer.from('working bytes').toString('base64')
      }
    ]
  })) as { id: string }
  const path = (await r.artifacts.store.getArtifactPath(r.artifacts.db, artifact.id))!
  r.storage.applyTaskLifecycle('task', 'deleted', 1)
  expect(r.storage.pendingTaskCleanup()).toEqual(['task'])
  expect(existsSync(path)).toBe(true)
  await r.close()
  const next = runtime(root)
  expect(existsSync(path)).toBe(false)
  expect(next.storage.pendingTaskCleanup()).toEqual([])
})

test('review: a failed task purge preserves externally edited working originals with the live DB rows', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'review-storage-durability-')),
    r = runtime(root),
    route = { id: filesIdentity.id, epoch: 1 }
  const artifact = (await r.artifacts.invoke({
    route,
    method: 'uploadArtifactBlob',
    operationId: randomUUID(),
    args: [
      {
        taskId: 'task',
        title: 'original.txt',
        data: Buffer.from('saved version').toString('base64')
      }
    ]
  })) as { id: string }
  const path = (await r.artifacts.store.getArtifactPath(r.artifacts.db, artifact.id))!
  writeFileSync(path, 'external changes not yet versioned')
  r.storage.compose((db) =>
    db.exec(`
    CREATE TRIGGER review_fail_task_tombstone BEFORE UPDATE ON conversations
    WHEN NEW.id='files' AND NEW.state='deleted'
    BEGIN SELECT RAISE(ABORT,'review injected final SQL failure'); END;
  `)
  )
  await expect(r.applyTaskLifecycle('task', 'deleted', 1)).rejects.toThrow(/review injected/)
  expect(r.storage.taskLifecycle('task').state).toBe('active')
  expect(r.storage.conversation('files')?.state).toBe('active')
  expect(await r.artifacts.store.getArtifact(r.artifacts.db, artifact.id)).toMatchObject({
    id: artifact.id
  })
  expect(existsSync(path), 'rolled-back deletion must preserve the only working original').toBe(
    true
  )
  expect(readFileSync(path, 'utf8')).toBe('external changes not yet versioned')
  expect(r.storage.pendingTaskCleanup()).toEqual([])
  await r.close()
  const next = runtime(root)
  expect(next.storage.taskLifecycle('task').state).toBe('active')
  expect(readFileSync(path, 'utf8')).toBe('external changes not yet versioned')
})

test.each([true, false])(
  'review: opaque tool metadata cannot retain an otherwise expired sealed attachment (metadata=%s)',
  async (sameShape) => {
    const r = runtime(),
      now = Date.now(),
      old = now - 3 * 86_400_000
    const bytes = Buffer.from('old private attached bytes')
    const ref = r.attachments.put(
      'tab',
      {
        artifactId: 'file',
        name: 'private.txt',
        kind: 'text',
        mediaType: 'text/plain',
        size: bytes.length
      },
      bytes
    )
    r.storage.append(
      'chat',
      1,
      {
        kind: 'user-message',
        id: 'expired-user',
        text: 'old user attachment',
        content: [{ type: 'attachment', attachment: ref }]
      },
      old
    )
    r.storage.append(
      'chat',
      1,
      {
        kind: 'tool-call',
        id: 'retained-tool',
        name: 'external-service',
        input: sameShape
          ? { artifactId: ref.artifactId, contentHash: ref.contentHash }
          : { opaque: 'metadata' }
      },
      now
    )
    r.storage.compose((db) =>
      db.prepare("UPDATE records SET saved_at=? WHERE kind='attachment'").run(old)
    )
    r.retention.configure(1)
    const report = await r.retention.runNow(now)
    expect(r.storage.read('chat', -1)).toHaveLength(1)
    expect(report).toMatchObject({ events: 1, attachments: 1 })
    expect(existsSync(join(r.attachments.dir, ref.contentHash!))).toBe(false)
  }
)
