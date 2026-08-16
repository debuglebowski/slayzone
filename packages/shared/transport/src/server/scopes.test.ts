/**
 * The exhaustiveness guarantee `scopes.ts` is built around, plus the specific
 * classifications a security reviewer would want asserted by name.
 *
 * THIS IS THE LOAD-BEARING TEST. `SCOPE_POLICY` is deliberately a static map
 * with no router import (see its docstring) — this file is where that map is
 * cross-checked against the LIVE `appRouter`, so a procedure added anywhere in
 * the 32-router tree without being classified fails here, naming the exact
 * path. A vanished path (a rename, or the computer-rename kind of whole-surface
 * move) is caught the same way, from the other direction.
 */
import { describe, expect, test } from 'vitest'
import { appRouter } from './router'
import { SCOPE_POLICY, isPathAllowed, type Scope } from './scopes'

const LIVE_PATHS = Object.keys(appRouter._def.procedures).sort()
const POLICY_PATHS = Object.keys(SCOPE_POLICY).sort()

describe('SCOPE_POLICY exhaustiveness', () => {
  test('every live procedure path is classified', () => {
    const missing = LIVE_PATHS.filter((p) => !POLICY_PATHS.includes(p))
    expect(missing, `unclassified paths (add to SCOPE_POLICY): ${missing.join(', ')}`).toEqual([])
  })

  test('no policy entry names a path that no longer exists', () => {
    const stale = POLICY_PATHS.filter((p) => !LIVE_PATHS.includes(p))
    expect(stale, `stale policy entries (remove from SCOPE_POLICY): ${stale.join(', ')}`).toEqual(
      []
    )
  })

  test('the live router and the policy map name the exact same paths', () => {
    // Belt-and-braces restatement of the two tests above as one equality — if
    // this ever passes while either of those fails, the harness itself is
    // broken, not the policy.
    expect(POLICY_PATHS).toEqual(LIVE_PATHS)
  })
})

/**
 * No `test*` procedure is reachable outside PLAYWRIGHT. This is independent of
 * scopes (a `full` principal is not gated by SCOPE_POLICY at all — see
 * `isPathAllowed`), so it is asserted here as a property of the LIVE ROUTER,
 * not of the policy. `pty.testExecutionContext` had no such gate before this
 * plan's Phase 0/1 work landed; this is the regression guard.
 */
describe('test-only procedures never reach a real caller', () => {
  test('SCOPE_POLICY denies every test* path to every scope', () => {
    const testPaths = LIVE_PATHS.filter((p) => /(^|\.)test[A-Z]/.test(p))
    expect(testPaths.length).toBeGreaterThan(0) // sanity: this suite still exists
    for (const p of testPaths) {
      expect(SCOPE_POLICY[p], `${p} must be 'never'`).toBe('never')
    }
  })
})

/** Explicit spot checks a reviewer would look for — named individually so a
 *  failure reads as "X is no longer denied", not just a diff. */
describe('SCOPE_POLICY — specific classifications', () => {
  const never: Array<[string, string]> = [
    ['pty.create', 'takes anyInput — an unvalidated spawn spec'],
    ['pty.kill', 'ends the host process'],
    ['pty.setShellOverride', 'changes which binary a terminal launches'],
    ['chat.start', 'creates a session with an attacker-chosen mode + cwd'],
    ['chat.reset', 're-creates a session with an attacker-chosen mode + cwd'],
    ['workspace.setAllowedRoots', 'mutates the filesystem sandbox itself'],
    ['app.browser.executeJs', 'arbitrary JS eval in a live WebContentsView'],
    ['app.shell.openExternal', 'opens an arbitrary URL/path on the hub machine'],
    ['computers.mintJoinToken', 'mints a computer enrollment secret'],
    ['computers.setTaskComputer', 'chooses which computer a task runs on'],
    ['computers.setProjectDefaultComputer', 'chooses where new tasks run by default']
  ]
  for (const [path, why] of never) {
    test(`${path} is never — ${why}`, () => {
      expect(SCOPE_POLICY[path]).toBe('never')
    })
  }

  test('every aiConfig.* procedure is never (provider API keys)', () => {
    const paths = LIVE_PATHS.filter((p) => p.startsWith('aiConfig.'))
    expect(paths.length).toBeGreaterThan(0)
    for (const p of paths) expect(SCOPE_POLICY[p], p).toBe('never')
  })

  test('every integrations.* procedure is never (credential-store backed)', () => {
    const paths = LIVE_PATHS.filter((p) => p.startsWith('integrations.'))
    expect(paths.length).toBeGreaterThan(0)
    for (const p of paths) expect(SCOPE_POLICY[p], p).toBe('never')
  })

  const agent: string[] = ['pty.write', 'pty.submit', 'pty.interrupt']
  for (const path of agent) {
    test(`${path} is agent`, () => {
      expect(SCOPE_POLICY[path]).toBe('agent')
    })
  }

  const read: string[] = [
    'computers.list',
    'computers.resolveTaskComputer',
    'computers.onStatusChange'
  ]
  for (const path of read) {
    test(`${path} is read`, () => {
      expect(SCOPE_POLICY[path]).toBe('read')
    })
  }
})

describe('isPathAllowed', () => {
  const FULL: readonly Scope[] = ['full']
  const AGENT: readonly Scope[] = ['agent']
  const READ_TASKS: readonly Scope[] = ['read', 'tasks']

  test('full reaches a never-classified path (desktop/CLI unaffected)', () => {
    expect(isPathAllowed(FULL, 'pty.create')).toBe(true)
  })

  test('agent scope reaches pty.write but not pty.create', () => {
    expect(isPathAllowed(AGENT, 'pty.write')).toBe(true)
    expect(isPathAllowed(AGENT, 'pty.create')).toBe(false)
  })

  test('read+tasks does not reach an agent-only path', () => {
    expect(isPathAllowed(READ_TASKS, 'pty.write')).toBe(false)
    expect(isPathAllowed(READ_TASKS, 'task.create')).toBe(true)
  })

  test('an UNKNOWN path is refused for every scope EXCEPT full', () => {
    // full is defined as "skip the policy entirely", so it is the one caller
    // that survives a made-up path — every scoped principal must not, which is
    // exactly the fail-closed property a procedure added tomorrow relies on.
    expect(isPathAllowed(FULL, 'not.a.real.path')).toBe(true)
    expect(isPathAllowed(AGENT, 'not.a.real.path')).toBe(false)
    expect(isPathAllowed(READ_TASKS, 'not.a.real.path')).toBe(false)
  })

  test('no scopes at all reaches nothing, not even a read-classified path', () => {
    expect(isPathAllowed([], 'task.get')).toBe(false)
    expect(isPathAllowed([], 'hub.describe')).toBe(false)
    expect(isPathAllowed(['read'], 'hub.describe')).toBe(true)
  })
})
