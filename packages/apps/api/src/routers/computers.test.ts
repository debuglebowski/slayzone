/**
 * computers router contract tests via tRPC `createCaller` against the harness DB.
 * The computers store + join-token helpers are electron-free (pure DB), imported
 * directly. Two dep classes are exercised:
 *   - pure computer-binding CRUD (list store rows, setTaskComputer,
 *     setProjectDefaultComputer, revokeComputer) — works with NO gateway wired.
 *   - live-computer ops (list connection-status merge, mintJoinToken) — driven by a
 *     fake ComputersDeps registry (setComputersDeps) standing in for the hub gateway.
 * Runs under vitest on Electron's node (better-sqlite3 native ABI).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { test, expect } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { computersRouter } from './computers.js'
import { setAuthGate, setComputersDeps, type ComputersDeps } from '../app-deps.js'
import { appRouter } from '../router.js'
import {
  registerComputer,
  decodeJoinToken,
  resolveTaskComputerId
} from '@slayzone/computers/server'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from '@slayzone/task/server'
import { setSecurityLogSink } from '@slayzone/platform/security-log'

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
  getHubUrl: () => 'ws://127.0.0.1:8788/computers'
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

test('computers.mintJoinToken: returns a decodable szjt1 token embedding the hub URL, with no pin', async () => {
  const minted = await caller.mintJoinToken({ label: 'office-mac' })
  expect(minted.label).toBe('office-mac')
  expect(typeof minted.token).toBe('string')
  const payload = decodeJoinToken(minted.token)
  expect(payload).not.toBeNull()
  expect(payload!.hubUrl).toBe('ws://127.0.0.1:8788/computers')
  // The hub presents no certificate of its own, so there is nothing to pin.
  expect('certFingerprint' in payload!).toBe(false)
  expect(minted.expiresAt).toBeGreaterThan(minted.createdAt)
  // The dial target is returned ALONGSIDE the token so a client can tell whether
  // the token is usable off-box without decoding it — `decodeJoinToken` needs
  // `Buffer`, which the renderer does not have. Not a secret: it is embedded in
  // the token the mint dialog already displays in full. Also brings this proc's
  // shape in line with the REST route, which has always returned it.
  expect(minted.hubUrl).toBe('ws://127.0.0.1:8788/computers')
  // Login off (no auth gate — the desktop app's hub): minted for nobody, as before
  // T-20, so the computer that redeems it is unowned.
  expect(
    h.db
      .prepare('SELECT minted_by_user_id, owner_user_id FROM join_tokens WHERE id = ?')
      .get(minted.id)
  ).toEqual({ minted_by_user_id: null, owner_user_id: null })
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

test('computers: revoke, unrevoke, delete, claim and visibility write audit lines naming the user (T-03)', async () => {
  const audit: Array<Record<string, unknown>> = []
  setSecurityLogSink((line) => audit.push(JSON.parse(line) as Record<string, unknown>))
  try {
    const asUser = computersRouter.createCaller({
      ...ctx,
      principal: { userId: 'user-9', role: 'user', scopes: ['full'] },
      req: { socket: { remoteAddress: '198.51.100.4' } } as never
    })
    const r = await registerComputer(h.slayDb, {
      name: 'audited',
      platform: 'linux-x64',
      version: '0.35.0'
    })
    await asUser.claim({ computerId: r.id })
    await asUser.setVisibility({ computerId: r.id, visibility: 'private' })
    await asUser.revokeComputer({ computerId: r.id })
    await asUser.unrevoke({ computerId: r.id })
    await asUser.delete({ computerId: r.id })
    expect(audit.map((l) => l.event)).toEqual([
      'computer.claim',
      'computer.visibility.set',
      'computer.revoke',
      'computer.unrevoke',
      'computer.delete'
    ])
    for (const l of audit) {
      expect(l.outcome).toBe('success')
      expect(l.actor).toBe('user-9')
      expect(l.ip).toBe('198.51.100.4')
      expect(l.targetKind).toBe('computer')
      expect(l.targetId).toBe(r.id)
    }
    expect((audit[1]!.detail as { visibility: string }).visibility).toBe('private')
    expect(audit[2]!.route).toBe('trpc revokeComputer')
  } finally {
    setSecurityLogSink()
  }
})

// Contract: with the gateway absent (init not yet resolved), `list` still returns store
// rows (all disconnected) and `mintJoinToken` fails cleanly instead of crashing.
test('computers: list degrades + mintJoinToken throws when the gateway is unwired', async () => {
  // Registry with no gateway + no URL — mirrors init-not-resolved (never populated),
  // but exercised here by resetting the deps to a null-gateway shape.
  setComputersDeps({
    getGateway: () => null,
    getHubUrl: () => null
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
    await createDbChatDataOps(h.slayDb, taskSessionStore).resolveComputerId(taskId)
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

/**
 * T-15 on a hub with login: the admin MANAGES every computer (sees it in the list,
 * changes its visibility, revokes, deletes) but gets no path to put work on one that
 * is not visible to them — binding a task is running code in that user's account
 * (O-4). A user manages only their own. Through the real `appRouter`, so the role
 * gate and the procedure checks run exactly as on the hub.
 */
test('T-15/T-19: an admin manages a private computer of another user but cannot bind work to it', async () => {
  setAuthGate(() => true)
  try {
    const bobs = await registerComputer(h.slayDb, {
      name: 'bob-private',
      platform: 'linux-x64',
      version: '0.35.0'
    })
    await h.slayDb.run(
      `UPDATE computers SET owner_user_id = 'bob', visibility = 'private' WHERE id = ?`,
      [bobs.id]
    )
    // The work is the admin's own, so what refuses the binding is the computer's
    // visibility, not the owner check (T-17) that would refuse someone else's task.
    await h.slayDb.run(`UPDATE projects SET owner_user_id = 'alice' WHERE id = ?`, [projectId])
    const as = (userId: string, role: 'admin' | 'user') =>
      appRouter.createCaller({ ...ctx, principal: { userId, role, scopes: ['full'] } }).computers
    const admin = as('alice', 'admin')
    const bob = as('bob', 'user')
    const carol = as('carol', 'user')
    const refusal = async (p: Promise<unknown>): Promise<string> =>
      p.then(
        () => 'ok',
        (e: { code?: string; cause?: { name?: string }; message?: string }) =>
          e.cause?.name === 'AdminOnlyError' ? `${e.code}:ADMIN_ONLY` : String(e.message)
      )

    // List: management metadata, so the admin sees it; another user does not.
    expect((await admin.list()).some((r) => r.id === bobs.id)).toBe(true)
    expect((await carol.list()).some((r) => r.id === bobs.id)).toBe(false)
    expect((await bob.list()).some((r) => r.id === bobs.id)).toBe(true)

    // Binding work: refused to the admin exactly like to any other non-owner — the
    // owner gate's NOT_FOUND on the computer id (T-19), even for the admin's own task.
    expect(await refusal(admin.setTaskComputer({ taskId, computerId: bobs.id }))).toBe('Not found')
    expect(await refusal(admin.setProjectDefaultComputer({ projectId, computerId: bobs.id }))).toBe(
      'Not found'
    )
    // ...and the owner of the computer cannot bind it to someone else's task.
    expect(await refusal(bob.setTaskComputer({ taskId, computerId: bobs.id }))).toBe('Not found')

    // Lifecycle of someone else's computer: admin only.
    expect(await refusal(carol.setVisibility({ computerId: bobs.id, visibility: 'hub' }))).toBe(
      'FORBIDDEN:ADMIN_ONLY'
    )
    expect(await refusal(carol.revokeComputer({ computerId: bobs.id }))).toBe(
      'FORBIDDEN:ADMIN_ONLY'
    )
    expect(await refusal(carol.claim({ computerId: bobs.id }))).toBe('FORBIDDEN:ADMIN_ONLY')
    expect(await refusal(carol.mintJoinToken({ label: 'x' }))).toBe('FORBIDDEN:ADMIN_ONLY')
    expect(await refusal(admin.setVisibility({ computerId: bobs.id, visibility: 'private' }))).toBe(
      'ok'
    )
    // Strictly private on a hub with login (O-6): nobody opens a computer up.
    expect(await refusal(bob.setVisibility({ computerId: bobs.id, visibility: 'hub' }))).toBe(
      'computers are private on a hub with login'
    )
    // Claiming is off on a hub with login, for the admin too.
    expect((await refusal(admin.claim({ computerId: bobs.id }))).startsWith('claiming')).toBe(true)
    // The owner manages their own — except undoing a revocation, the admin's alone.
    expect(await refusal(bob.revokeComputer({ computerId: bobs.id }))).toBe('ok')
    expect(await refusal(bob.unrevoke({ computerId: bobs.id }))).toBe('FORBIDDEN:ADMIN_ONLY')
    expect(await refusal(admin.unrevoke({ computerId: bobs.id }))).toBe('ok')
    expect(await refusal(carol.delete({ computerId: bobs.id }))).toBe('FORBIDDEN:ADMIN_ONLY')
    expect(await refusal(admin.delete({ computerId: bobs.id }))).toBe('ok')
    // A missing id reads the same to a user as someone else's, and as missing to an admin.
    expect(await refusal(carol.revokeComputer({ computerId: 'no-such' }))).toBe(
      'FORBIDDEN:ADMIN_ONLY'
    )
    expect(
      (await refusal(admin.revokeComputer({ computerId: 'no-such' }))).includes('no such')
    ).toBe(true)

    // An unowned computer (T-19): the admin's to manage, nobody's to use or list.
    const unowned = await registerComputer(h.slayDb, {
      name: 'nobodys',
      platform: 'linux-x64',
      version: '0.35.0'
    })
    expect((await admin.list()).some((r) => r.id === unowned.id)).toBe(true)
    expect((await bob.list()).some((r) => r.id === unowned.id)).toBe(false)
    expect(await refusal(admin.setTaskComputer({ taskId, computerId: unowned.id }))).toBe(
      'Not found'
    )
    expect(await refusal(bob.revokeComputer({ computerId: unowned.id }))).toBe(
      'FORBIDDEN:ADMIN_ONLY'
    )
    expect(await refusal(admin.delete({ computerId: unowned.id }))).toBe('ok')

    // The owner binds their own computer to their own work.
    const alices = await registerComputer(h.slayDb, {
      name: 'alice-box',
      platform: 'linux-x64',
      version: '0.35.0'
    })
    await h.slayDb.run(`UPDATE computers SET owner_user_id = 'alice' WHERE id = ?`, [alices.id])
    const aliceAsUser = as('alice', 'user')
    expect(await refusal(aliceAsUser.setTaskComputer({ taskId, computerId: alices.id }))).toBe('ok')
    expect(await refusal(aliceAsUser.setTaskComputer({ taskId, computerId: null }))).toBe('ok')
    await h.slayDb.run(`DELETE FROM computers WHERE id = ?`, [alices.id])
  } finally {
    setAuthGate(() => false)
    await h.slayDb.run(`UPDATE projects SET owner_user_id = NULL WHERE id = ?`, [projectId])
  }
})

/**
 * T-20 (O-5) through the real `appRouter`, on a hub with login: only an admin mints
 * (the role gate, with its audit line), always FOR a named, enabled user who owns the
 * computer, for at most 1 hour. Each refusal is BAD_REQUEST with a stable `appCode`
 * and one `computer.join_token.mint` denied line; nothing is minted.
 */
test('T-20: an admin mints only for a named, enabled user, at most 1 hour; a user cannot mint', async () => {
  setAuthGate(() => true)
  const accounts: Record<string, { userId: string; disabled: boolean }> = {
    'bob@example.com': { userId: 'bob', disabled: false },
    bob: { userId: 'bob', disabled: false },
    dave: { userId: 'dave', disabled: true }
  }
  setComputersDeps({ ...fakeDeps, findAccount: async (ref) => accounts[ref] ?? null })
  const audit: Array<Record<string, unknown>> = []
  setSecurityLogSink((line) => audit.push(JSON.parse(line) as Record<string, unknown>))
  const tokens = () =>
    (h.db.prepare('SELECT COUNT(*) AS n FROM join_tokens').get() as { n: number }).n
  try {
    const as = (userId: string, role: 'admin' | 'user') =>
      appRouter.createCaller({ ...ctx, principal: { userId, role, scopes: ['full'] } }).computers
    const admin = as('alice', 'admin')
    const refusal = async (p: Promise<unknown>): Promise<string> =>
      p.then(
        () => 'ok',
        (e: { code?: string; cause?: { name?: string; code?: string } }) =>
          `${e.code}:${e.cause?.name === 'AdminOnlyError' ? 'ADMIN_ONLY' : e.cause?.code}`
      )
    const before = tokens()

    expect(await refusal(as('carol', 'user').mintJoinToken({ label: 'x', forUser: 'bob' }))).toBe(
      'FORBIDDEN:ADMIN_ONLY'
    )
    expect(await refusal(admin.mintJoinToken({ label: 'x' }))).toBe(
      'BAD_REQUEST:JOIN_TOKEN_OWNER_REQUIRED'
    )
    expect(await refusal(admin.mintJoinToken({ label: 'x', forUser: 'nobody@example.com' }))).toBe(
      'BAD_REQUEST:JOIN_TOKEN_OWNER_UNKNOWN'
    )
    expect(await refusal(admin.mintJoinToken({ label: 'x', forUser: 'dave' }))).toBe(
      'BAD_REQUEST:JOIN_TOKEN_OWNER_DISABLED'
    )
    expect(
      await refusal(admin.mintJoinToken({ label: 'x', forUser: 'bob', ttlMs: 2 * 60 * 60_000 }))
    ).toBe('BAD_REQUEST:JOIN_TOKEN_TTL_TOO_LONG')
    expect(tokens()).toBe(before)
    // The stable code reaches a client as `data.appCode`, as ADMIN_ONLY does.
    const err = await admin.mintJoinToken({ label: 'x' }).catch((e: unknown) => e)
    audit.pop()
    const shape = appRouter._def._config.errorFormatter({
      error: err,
      type: 'mutation',
      path: 'computers.mintJoinToken',
      input: undefined,
      ctx: undefined,
      shape: { message: 'x', code: -32600, data: { code: 'BAD_REQUEST' } }
    } as never) as { data: { appCode?: string } }
    expect(shape.data.appCode).toBe('JOIN_TOKEN_OWNER_REQUIRED')

    const minted = await admin.mintJoinToken({ label: 'bob-laptop', forUser: 'bob@example.com' })
    expect(minted.expiresAt - minted.createdAt).toBe(15 * 60_000)
    expect(
      h.db
        .prepare('SELECT minted_by_user_id, owner_user_id FROM join_tokens WHERE id = ?')
        .get(minted.id)
    ).toEqual({ minted_by_user_id: 'alice', owner_user_id: 'bob' })

    expect(audit.map((l) => `${l.event}:${l.outcome}:${l.actor}`)).toEqual([
      'authz.denied:denied:carol',
      'computer.join_token.mint:denied:alice',
      'computer.join_token.mint:denied:alice',
      'computer.join_token.mint:denied:alice',
      'computer.join_token.mint:denied:alice',
      'computer.join_token.mint:success:alice'
    ])
    expect(audit.map((l) => (l.detail as { reason?: string }).reason)).toEqual([
      'not_admin',
      'JOIN_TOKEN_OWNER_REQUIRED',
      'JOIN_TOKEN_OWNER_UNKNOWN',
      'JOIN_TOKEN_OWNER_DISABLED',
      'JOIN_TOKEN_TTL_TOO_LONG',
      undefined
    ])
    expect(audit[5]!.detail).toEqual({ label: 'bob-laptop', ttlMs: 15 * 60_000, owner: 'bob' })
    expect(audit[5]!.route).toBe('trpc computers.mintJoinToken')
    const all = JSON.stringify(audit)
    expect(all.includes(minted.token)).toBe(false)
    expect(all.includes(decodeJoinToken(minted.token)!.secret)).toBe(false)
    expect(all.includes('bob@example.com')).toBe(false)
  } finally {
    setAuthGate(() => false)
    setComputersDeps(fakeDeps)
    setSecurityLogSink()
  }

  // Login off again: naming a user is refused rather than silently ignored.
  let code: string | undefined
  await caller
    .mintJoinToken({ label: 'x', forUser: 'bob' })
    .catch((e: { cause?: { code?: string } }) => {
      code = e.cause?.code
    })
  expect(code).toBe('JOIN_TOKEN_OWNER_UNSUPPORTED')
})
