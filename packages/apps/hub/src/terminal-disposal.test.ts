import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { deleteProject } from '@slayzone/projects/server'
import { eraseContent, onTaskErased } from '@slayzone/content-erasure/server'
import { createPtyOps, setPtySpawnLookups } from '@slayzone/terminal/hub'
import { createPty } from '../../../domains/terminal/src/server/runtime/pty-manager'
import { createFakeTaskSessionStore } from '../../../domains/terminal/src/server/runtime/fake-task-session-store'
import { wireTerminalDisposal } from './terminal-disposal'

vi.mock('../../../domains/terminal/src/server/runtime/pty-manager', async (original) => ({
  ...(await original<typeof import('../../../domains/terminal/src/server/runtime/pty-manager')>()),
  createPty: vi.fn(async () => ({ success: true })),
  killPty: () => false
}))

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
  setPtySpawnLookups(null)
  vi.clearAllMocks()
})

async function fixture() {
  const h = await createTestHarness()
  cleanup.push(() => h.cleanup())
  for (const owner of ['alice', 'bob']) {
    await h.slayDb.run('INSERT INTO projects(id,name,color,owner_user_id) VALUES(?,?,?,?)', [
      `p-${owner}`,
      owner,
      '#123456',
      owner
    ])
    await h.slayDb.run('INSERT INTO tasks(id,project_id,title) VALUES(?,?,?)', [
      `t-${owner}`,
      `p-${owner}`,
      owner
    ])
  }
  setPtySpawnLookups({
    getAgent: async () => null,
    getTaskProjectId: async () => null,
    resolveComputerId: async () => 'pc',
    resolveProjectComputerId: async () => 'pc',
    getProjectRoot: async () => '/repo'
  })
  const ops = createPtyOps(h.slayDb, createFakeTaskSessionStore())
  cleanup.push(() => ops.dispose())
  // A failing observer must not prevent terminal disposal for any erased task.
  cleanup.push(
    onTaskErased(h.slayDb, () => {
      throw new Error('observer failed')
    })
  )
  cleanup.push(wireTerminalDisposal(h.slayDb, ops))
  const window = {
    isDestroyed: () => false,
    webContents: { send: () => undefined, getURL: () => '' }
  }
  await ops.ptyKill('t-alice:t-alice')
  await ops.ptyKill('t-bob:t-bob')
  await h.slayDb.run("INSERT INTO tasks(id,project_id,title) VALUES('t-alice-2','p-alice','A2')")
  await ops.ptyKill('t-alice-2:t-alice-2')
  const next = async (id: string) => {
    await ops.ptyCreate({ sessionId: `${id}:${id}`, cwd: '/repo', mode: 'terminal' }, window)
    return vi.mocked(createPty).mock.calls.at(-1)?.[0].takeOver
  }
  return { h, next }
}

test.each(['project', 'user'] as const)(
  'actual %s erasure disposes only erased task tokens after commit',
  async (scope) => {
    const { h, next } = await fixture()
    if (scope === 'project')
      expect(await deleteProject(h.slayDb, 'p-alice', join(h.tmpDir(), 'project-icons'))).toBe(true)
    else await eraseContent(h.slayDb, h.tmpDir(), { kind: 'user', userId: 'alice' })
    expect(await h.slayDb.get("SELECT 1 FROM tasks WHERE id='t-alice'")).toBeUndefined()
    expect(await next('t-alice')).not.toBe(false)
    expect(await next('t-alice-2')).not.toBe(false)
    expect(await next('t-bob')).toBe(false)
  }
)

test('failed database erasure preserves valid task token', async () => {
  const { h, next } = await fixture()
  const original = h.slayDb.namedTxn.bind(h.slayDb)
  vi.spyOn(h.slayDb, 'namedTxn').mockImplementation(async (...args) => {
    if (args[0] === 'content-erasure:commit') throw new Error('commit refused')
    return original(...args)
  })
  const report = await eraseContent(h.slayDb, h.tmpDir(), { kind: 'user', userId: 'alice' })
  expect(report.failures).toContain('DATABASE_CONTENT_NOT_DELETED')
  expect(await h.slayDb.get("SELECT 1 FROM tasks WHERE id='t-alice'")).toBeDefined()
  expect(await next('t-alice')).toBe(false)
})
