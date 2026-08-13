/**
 * computers router contract tests via tRPC `createCaller` against the harness DB.
 * The computers store + join-token helpers are electron-free (pure DB), imported
 * directly. Two dep classes are exercised:
 *   - pure computer-binding CRUD (list store rows, setTaskComputer,
 *     setProjectDefaultComputer, revokeComputer) — works with NO gateway wired.
 *   - live-computer ops (list connection-status merge, mintJoinToken) — driven by a
 *     fake ComputersDeps registry (setComputersDeps) standing in for the hub gateway.
 * Runs under the electron strict loader (better-sqlite3 native ABI).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { createTestHarness, test, expect } from '../../../../test-utils/ipc-harness.js'
import { computersRouter } from './computers.js'
import { setComputersDeps, type ComputersDeps } from '../app-deps.js'
import {
  registerComputer,
  decodeJoinToken,
  resolveTaskComputerId
} from '@slayzone/computers/server'
import { createDbChatDataOps } from '@slayzone/terminal/server'

const h = await createTestHarness()
const ctx = { db: h.slayDb, dataRoot: mkdtempSync(join(tmpdir(), 'trpc-computers-')) }
const caller = computersRouter.createCaller(ctx)

// Seed a project + task for the computer-binding mutations.
const projectId = crypto.randomUUID()
const taskId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P', '#000')
h.db
  .prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)')
  .run(taskId, projectId, 'T')

// Fake computer gateway registry — one connected computer + a bound hub URL + cert.
// `usableComputerIds` defaults to mirroring `liveComputerIds`: the common case is a
// healthy computer, where socket-open and usable agree. A test that needs them to
// DIVERGE (silent-but-open computer) sets it explicitly.
let liveComputerIds: string[] = []
let usableComputerIds: string[] | null = null
const asDescriptors = (
  ids: string[]
): Array<{
  computerId: string
  connectedAt: number
  lastSeenAt: number
}> => ids.map((computerId) => ({ computerId, connectedAt: 111, lastSeenAt: 222 }))
const fakeDeps: ComputersDeps = {
  getGateway: () => ({
    listComputers: () => asDescriptors(liveComputerIds),
    listUsableComputers: () => asDescriptors(usableComputerIds ?? liveComputerIds)
  }),
  getHubUrl: () => 'ws://127.0.0.1:8788/computers',
  getCertFingerprint: () => 'abcdef0123456789'
}
setComputersDeps(fakeDeps)

test('computers.list: returns store rows merged with live connection status', async () => {
  const a = await registerComputer(h.slayDb, {
    name: 'mac-studio',
    platform: 'darwin-arm64',
    version: '0.35.0',
    capabilities: { pty: true, git: true }
  })
  await registerComputer(h.slayDb, { name: 'linux-box', platform: 'linux-x64', version: '0.35.0' })

  // Only `a` is currently dialed in.
  liveComputerIds = [a.id]

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

test('computers.mintJoinToken: returns a decodable szjt1 token embedding hub URL + cert', async () => {
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

test('computers.setProjectDefaultComputer + setTaskComputer + resolveTaskComputer', async () => {
  // Real rows, not arbitrary strings: binding now asserts the computer is one
  // this caller may actually use, so a made-up id is refused — which is the
  // point of the guard.
  const dflt = await registerComputer(h.slayDb, {
    name: 'default-box',
    platform: 'darwin-arm64',
    version: '0.36.0'
  })
  const pinned = await registerComputer(h.slayDb, {
    name: 'pinned-box',
    platform: 'darwin-arm64',
    version: '0.36.0'
  })

  await caller.setProjectDefaultComputer({ projectId, computerId: dflt.id })
  expect((await caller.resolveTaskComputer({ taskId })).computerId).toBe(dflt.id)

  await caller.setTaskComputer({ taskId, computerId: pinned.id })
  expect((await caller.resolveTaskComputer({ taskId })).computerId).toBe(pinned.id)

  await caller.setTaskComputer({ taskId, computerId: null })
  expect((await caller.resolveTaskComputer({ taskId })).computerId).toBe(dflt.id)
})

test('computers.revokeComputer: drops the computer from the active list', async () => {
  const r = await registerComputer(h.slayDb, {
    name: 'to-revoke',
    platform: 'darwin-arm64',
    version: '0.35.0'
  })
  liveComputerIds = []
  expect((await caller.list()).some((row) => row.id === r.id)).toBe(true)
  await caller.revokeComputer({ computerId: r.id })
  expect((await caller.list()).some((row) => row.id === r.id)).toBe(false)
})

// Contract: with the gateway absent (init not yet resolved), `list` still returns store
// rows (all disconnected) and `mintJoinToken` fails cleanly instead of crashing.
test('computers: list degrades + mintJoinToken throws when the gateway is unwired', async () => {
  // Registry with no gateway + no URL — mirrors init-not-resolved (never populated),
  // but exercised here by resetting the deps to a null-gateway shape.
  setComputersDeps({
    getGateway: () => null,
    getHubUrl: () => null,
    getCertFingerprint: () => null
  })

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
  setComputersDeps(fakeDeps)
})

test('computers.list: `usable` is independent of `connected`', async () => {
  const r = await registerComputer(h.slayDb, {
    name: 'silent-box',
    platform: 'linux-x64',
    version: '0.35.0',
    capabilities: { pty: true }
  })
  // Socket open, but the computer has gone quiet and its watchdog has not reaped it.
  // Callers that gate work on `connected` would dispatch into a void here; `usable`
  // is what tells them not to.
  liveComputerIds = [r.id]
  usableComputerIds = []
  const rows = (await caller.list()) as Array<{
    id: string
    connected: boolean
    usable: boolean
  }>
  const row = rows.find((x) => x.id === r.id)
  expect(row?.connected).toBe(true)
  expect(row?.usable).toBe(false)

  // And they agree again once it is heard from.
  usableComputerIds = [r.id]
  const healthy = (await caller.list()) as Array<{ id: string; usable: boolean }>
  expect(healthy.find((x) => x.id === r.id)?.usable).toBe(true)
  usableComputerIds = null
})

// A chat agent and a terminal agent for the SAME task must land on the SAME
// machine. Computer resolution is written TWICE — `resolveTaskComputerId` in the
// computers store, and an inlined statement in chat-data-ops — so any divergence
// splits one task's work across two computers, only one of which holds the
// checkout. This test exists to pin the two statements together; if you change
// one COALESCE, this fails until you change the other.
test('pty and chat resolve a task to the SAME computer at every precedence step', async () => {
  await h.slayDb.run(
    `INSERT INTO projects (id, name, color, sort_order, default_computer_id)
     VALUES ('p-res', 'P', '#fff', 0, 'r-default')`
  )
  await h.slayDb.run(
    `INSERT INTO tasks (id, project_id, title, status, computer_id)
     VALUES ('t-res', 'p-res', 'T', 'todo', 'r-task')`
  )

  const both = async (taskId: string): Promise<[string | null, string | null]> => [
    await resolveTaskComputerId(h.slayDb, taskId),
    await createDbChatDataOps(h.slayDb).resolveComputerId(taskId)
  ]

  // The task's own pin wins over the project default.
  expect(await both('t-res')).toEqual(['r-task', 'r-task'])

  // Unpinned, it falls through to the project default.
  await h.slayDb.run(`UPDATE tasks SET computer_id = NULL WHERE id = 't-res'`)
  expect(await both('t-res')).toEqual(['r-default', 'r-default'])

  // Neither set: null, so the caller applies its own fallback rather than
  // silently inheriting some other project's machine.
  await h.slayDb.run(`UPDATE projects SET default_computer_id = NULL WHERE id = 'p-res'`)
  expect(await both('t-res')).toEqual([null, null])
})
