/**
 * runners router contract tests via tRPC `createCaller` against the harness DB.
 * The runners store + join-token helpers are electron-free (pure DB), imported
 * directly. Two dep classes are exercised:
 *   - pure runner-binding CRUD (list store rows, setTaskRunner,
 *     setProjectDefaultRunner, revokeRunner) — works with NO gateway wired.
 *   - live-runner ops (list connection-status merge, mintJoinToken) — driven by a
 *     fake RunnersDeps registry (setRunnersDeps) standing in for the hub gateway.
 * Runs under the electron strict loader (better-sqlite3 native ABI).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { createTestHarness, test, expect } from '../../../../test-utils/ipc-harness.js'
import { computersRouter } from './computers.js'
import { setRunnersDeps, type RunnersDeps } from '../app-deps.js'
import {
  registerRunner,
  decodeJoinToken,
  resolveTaskRunnerId
} from '@slayzone/computers/server'
import { createDbChatDataOps } from '@slayzone/terminal/server'

const h = await createTestHarness()
const ctx = { db: h.slayDb, dataRoot: mkdtempSync(join(tmpdir(), 'trpc-runners-')) }
const caller = computersRouter.createCaller(ctx)

// Seed a project + task for the runner-binding mutations.
const projectId = crypto.randomUUID()
const taskId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P', '#000')
h.db
  .prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)')
  .run(taskId, projectId, 'T')

// Fake runner gateway registry — one connected runner + a bound hub URL + cert.
// `usableRunnerIds` defaults to mirroring `liveRunnerIds`: the common case is a
// healthy runner, where socket-open and usable agree. A test that needs them to
// DIVERGE (silent-but-open runner) sets it explicitly.
let liveRunnerIds: string[] = []
let usableRunnerIds: string[] | null = null
const asDescriptors = (
  ids: string[]
): Array<{
  runnerId: string
  connectedAt: number
  lastSeenAt: number
}> => ids.map((runnerId) => ({ runnerId, connectedAt: 111, lastSeenAt: 222 }))
const fakeDeps: RunnersDeps = {
  getGateway: () => ({
    listRunners: () => asDescriptors(liveRunnerIds),
    listUsableRunners: () => asDescriptors(usableRunnerIds ?? liveRunnerIds)
  }),
  getHubUrl: () => 'ws://127.0.0.1:8788/computers',
  getCertFingerprint: () => 'abcdef0123456789'
}
setRunnersDeps(fakeDeps)

test('runners.list: returns store rows merged with live connection status', async () => {
  const a = await registerRunner(h.slayDb, {
    name: 'mac-studio',
    platform: 'darwin-arm64',
    version: '0.35.0',
    capabilities: { pty: true, git: true }
  })
  await registerRunner(h.slayDb, { name: 'linux-box', platform: 'linux-x64', version: '0.35.0' })

  // Only `a` is currently dialed in.
  liveRunnerIds = [a.id]

  const rows = await caller.list()
  expect(rows.length).toBe(2)
  const macRow = rows.find((r) => r.id === a.id)!
  expect(macRow.name).toBe('mac-studio')
  expect(macRow.connected).toBe(true)
  expect(macRow.connectedAt).toBe(111)
  expect(macRow.capabilities.includes('pty')).toBe(true)
  const linuxRow = rows.find((r) => r.name === 'linux-box')!
  expect(linuxRow.connected).toBe(false)
  expect(linuxRow.connectedAt).toBeNull()
})

test('runners.mintJoinToken: returns a decodable szjt1 token embedding hub URL + cert', async () => {
  const minted = await caller.mintJoinToken({ label: 'office-mac' })
  expect(minted.label).toBe('office-mac')
  expect(typeof minted.token).toBe('string')
  const payload = decodeJoinToken(minted.token)
  expect(payload).not.toBeNull()
  expect(payload!.hubUrl).toBe('ws://127.0.0.1:8788/computers')
  expect(payload!.certFingerprint).toBe('abcdef0123456789')
  expect(minted.expiresAt).toBeGreaterThan(minted.createdAt)
  // The dial target is returned ALONGSIDE the token so a client can tell whether
  // the token is usable off-box without decoding it — `decodeJoinToken` needs
  // `Buffer`, which the renderer does not have. Not a secret: it is embedded in
  // the token the mint dialog already displays in full. Also brings this proc's
  // shape in line with the REST route, which has always returned it.
  expect(minted.hubUrl).toBe('ws://127.0.0.1:8788/computers')
})

test('runners.setProjectDefaultRunner + setTaskRunner + resolveTaskRunner', async () => {
  await caller.setProjectDefaultRunner({ projectId, runnerId: 'runner-default' })
  expect((await caller.resolveTaskRunner({ taskId })).runnerId).toBe('runner-default')

  await caller.setTaskRunner({ taskId, runnerId: 'runner-pinned' })
  expect((await caller.resolveTaskRunner({ taskId })).runnerId).toBe('runner-pinned')

  await caller.setTaskRunner({ taskId, runnerId: null })
  expect((await caller.resolveTaskRunner({ taskId })).runnerId).toBe('runner-default')
})

test('runners.revokeRunner: drops the runner from the active list', async () => {
  const r = await registerRunner(h.slayDb, {
    name: 'to-revoke',
    platform: 'darwin-arm64',
    version: '0.35.0'
  })
  liveRunnerIds = []
  expect((await caller.list()).some((row) => row.id === r.id)).toBe(true)
  await caller.revokeRunner({ runnerId: r.id })
  expect((await caller.list()).some((row) => row.id === r.id)).toBe(false)
})

// Contract: with the gateway absent (init not yet resolved), `list` still returns store
// rows (all disconnected) and `mintJoinToken` fails cleanly instead of crashing.
test('runners: list degrades + mintJoinToken throws when the gateway is unwired', async () => {
  // Registry with no gateway + no URL — mirrors init-not-resolved (never populated),
  // but exercised here by resetting the deps to a null-gateway shape.
  setRunnersDeps({ getGateway: () => null, getHubUrl: () => null, getCertFingerprint: () => null })

  const rows = await caller.list()
  expect(rows.every((r) => r.connected === false)).toBe(true)

  let threw = false
  try {
    await caller.mintJoinToken({ label: 'x' })
  } catch {
    threw = true
  }
  expect(threw).toBe(true)

  // Restore the fake gateway for any later runs (test order independence).
  setRunnersDeps(fakeDeps)
})

test('runners.list: `usable` is independent of `connected`', async () => {
  const r = await registerRunner(h.slayDb, {
    name: 'silent-box',
    platform: 'linux-x64',
    version: '0.35.0',
    capabilities: { pty: true }
  })
  // Socket open, but the runner has gone quiet and its watchdog has not reaped it.
  // Callers that gate work on `connected` would dispatch into a void here; `usable`
  // is what tells them not to.
  liveRunnerIds = [r.id]
  usableRunnerIds = []
  const rows = (await caller.list()) as Array<{
    id: string
    connected: boolean
    usable: boolean
  }>
  const row = rows.find((x) => x.id === r.id)
  expect(row?.connected).toBe(true)
  expect(row?.usable).toBe(false)

  // And they agree again once it is heard from.
  usableRunnerIds = [r.id]
  const healthy = (await caller.list()) as Array<{ id: string; usable: boolean }>
  expect(healthy.find((x) => x.id === r.id)?.usable).toBe(true)
  usableRunnerIds = null
})

// A chat agent and a terminal agent for the SAME task must land on the SAME
// machine. Runner resolution is written TWICE — `resolveTaskRunnerId` in the
// runners store, and an inlined statement in chat-data-ops — so any divergence
// splits one task's work across two runners, only one of which holds the
// checkout. This test exists to pin the two statements together; if you change
// one COALESCE, this fails until you change the other.
test('pty and chat resolve a task to the SAME runner at every precedence step', async () => {
  await h.slayDb.run(
    `INSERT INTO projects (id, name, color, sort_order, default_runner_id)
     VALUES ('p-res', 'P', '#fff', 0, 'r-default')`
  )
  await h.slayDb.run(
    `INSERT INTO tasks (id, project_id, title, status, runner_id)
     VALUES ('t-res', 'p-res', 'T', 'todo', 'r-task')`
  )

  const both = async (taskId: string): Promise<[string | null, string | null]> => [
    await resolveTaskRunnerId(h.slayDb, taskId),
    await createDbChatDataOps(h.slayDb).resolveRunnerId(taskId)
  ]

  // The task's own pin wins over the project default.
  expect(await both('t-res')).toEqual(['r-task', 'r-task'])

  // Unpinned, it falls through to the project default.
  await h.slayDb.run(`UPDATE tasks SET runner_id = NULL WHERE id = 't-res'`)
  expect(await both('t-res')).toEqual(['r-default', 'r-default'])

  // Neither set: null, so the caller applies its own fallback rather than
  // silently inheriting some other project's machine.
  await h.slayDb.run(`UPDATE projects SET default_runner_id = NULL WHERE id = 'p-res'`)
  expect(await both('t-res')).toEqual([null, null])
})
