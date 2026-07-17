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
import { runnersRouter } from './runners.js'
import { setRunnersDeps, type RunnersDeps } from '../app-deps.js'
import { registerRunner, decodeJoinToken } from '@slayzone/runners/server'

const h = await createTestHarness()
const ctx = { db: h.slayDb, dataRoot: mkdtempSync(join(tmpdir(), 'trpc-runners-')) }
const caller = runnersRouter.createCaller(ctx)

// Seed a project + task for the runner-binding mutations.
const projectId = crypto.randomUUID()
const taskId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P', '#000')
h.db.prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)').run(taskId, projectId, 'T')

// Fake runner gateway registry — one connected runner + a bound hub URL + cert.
let liveRunnerIds: string[] = []
const fakeDeps: RunnersDeps = {
  getGateway: () => ({
    listRunners: () =>
      liveRunnerIds.map((runnerId) => ({ runnerId, connectedAt: 111, lastSeenAt: 222 }))
  }),
  getHubUrl: () => 'ws://127.0.0.1:8788/runners',
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
  expect(payload!.hubUrl).toBe('ws://127.0.0.1:8788/runners')
  expect(payload!.certFingerprint).toBe('abcdef0123456789')
  expect(minted.expiresAt).toBeGreaterThan(minted.createdAt)
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
