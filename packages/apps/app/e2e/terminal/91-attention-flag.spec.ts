/**
 * needs_attention flag — running → idle/error only flags the task when the
 * session has had real user input. Spawn/banner settle on auto-respawn after
 * task open must NOT flag.
 */
import { test, expect, seed, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import type { ElectronApplication } from 'playwright'

type State = 'starting' | 'running' | 'idle' | 'error' | 'dead'

async function readFlag(electronApp: ElectronApplication, taskId: string): Promise<number> {
  return electronApp.evaluate(({ }, id: string): number => {
    const db = (globalThis as Record<string, unknown>).__db as {
      prepare: (sql: string) => { get: (...args: unknown[]) => { needs_attention: number } | undefined }
    }
    const row = db.prepare('SELECT needs_attention FROM tasks WHERE id = ?').get(id)
    return row?.needs_attention ?? 0
  }, taskId)
}

async function setFlag(electronApp: ElectronApplication, taskId: string, value: 0 | 1): Promise<void> {
  await electronApp.evaluate(({ }, args: { id: string; value: number }) => {
    const db = (globalThis as Record<string, unknown>).__db as {
      prepare: (sql: string) => { run: (...args: unknown[]) => unknown }
    }
    db.prepare('UPDATE tasks SET needs_attention = ? WHERE id = ?').run(args.value, args.id)
  }, { id: taskId, value })
}

async function fireStateChange(
  electronApp: ElectronApplication,
  sessionId: string,
  next: State,
  prev: State,
): Promise<void> {
  await electronApp.evaluate(({ }, args: { sid: string; next: string; prev: string }) => {
    const fn = (globalThis as Record<string, unknown>).__notifyPtyState as (
      sid: string, next: string, prev: string,
    ) => void
    fn(args.sid, args.next, args.prev)
  }, { sid: sessionId, next, prev })
}

async function markUserInput(electronApp: ElectronApplication, sessionId: string): Promise<void> {
  await electronApp.evaluate(({ }, sid: string) => {
    const fn = (globalThis as Record<string, unknown>).__markSessionUserInput as (s: string) => void
    fn(sid)
  }, sessionId)
}

async function clearUserInput(electronApp: ElectronApplication, sessionId: string): Promise<void> {
  await electronApp.evaluate(({ }, sid: string) => {
    const fn = (globalThis as Record<string, unknown>).__clearSessionUserInputMark as (s: string) => void
    fn(sid)
  }, sessionId)
}

test.describe('Attention flag gating', () => {
  let taskId: string
  const sid = (id: string): string => `${id}:${id}`

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Attn Gate', color: '#f43f5e', path: TEST_PROJECT_PATH })
    const t = await s.createTask({ projectId: p.id, title: 'Attention task', status: 'in_progress' })
    taskId = t.id
    await s.refreshData()
  })

  test.beforeEach(async ({ electronApp }) => {
    await setFlag(electronApp, taskId, 0)
    await clearUserInput(electronApp, sid(taskId))
  })

  test('running → idle WITHOUT user input does NOT flag (boot/banner case)', async ({ electronApp }) => {
    await fireStateChange(electronApp, sid(taskId), 'running', 'starting')
    await fireStateChange(electronApp, sid(taskId), 'idle', 'running')
    expect(await readFlag(electronApp, taskId)).toBe(0)
  })

  test('running → idle WITH user input DOES flag', async ({ electronApp }) => {
    await markUserInput(electronApp, sid(taskId))
    await fireStateChange(electronApp, sid(taskId), 'idle', 'running')
    expect(await readFlag(electronApp, taskId)).toBe(1)
  })

  test('running → error WITHOUT user input does NOT flag', async ({ electronApp }) => {
    await fireStateChange(electronApp, sid(taskId), 'error', 'running')
    expect(await readFlag(electronApp, taskId)).toBe(0)
  })

  test('running → error WITH user input DOES flag', async ({ electronApp }) => {
    await markUserInput(electronApp, sid(taskId))
    await fireStateChange(electronApp, sid(taskId), 'error', 'running')
    expect(await readFlag(electronApp, taskId)).toBe(1)
  })

  test('* → running clears flag regardless of user input mark', async ({ electronApp }) => {
    await setFlag(electronApp, taskId, 1)
    await fireStateChange(electronApp, sid(taskId), 'running', 'idle')
    expect(await readFlag(electronApp, taskId)).toBe(0)
  })
})
