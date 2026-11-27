/**
 * One hub per root (review-2 L7). A second hub on the same root — while a restore is
 * staged, it would swap the database under the first hub's open connection — refuses
 * to start. The lock is the OS's (SQLite's exclusive lock), so a hub that died, even by
 * SIGKILL, never leaves a stale lock behind.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { acquireHubRootLock, HubRootLockedError } from './root-lock.js'

const require = createRequire(import.meta.url)
const roots: string[] = []
const newRoot = () => {
  const r = mkdtempSync(join(tmpdir(), 'slz-root-lock-'))
  roots.push(r)
  return r
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe('hub root lock', () => {
  test('a second hub on the same root is refused; after release it can start', () => {
    const root = newRoot()
    const first = acquireHubRootLock(root)
    expect(() => acquireHubRootLock(root)).toThrow(HubRootLockedError)
    first.release()
    acquireHubRootLock(root).release()
  })

  test('another process holds it: refused; that process dies (SIGKILL): free again', async () => {
    const root = newRoot()
    const sqlite = require.resolve('better-sqlite3')
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const D=require(${JSON.stringify(sqlite)});const d=new D(${JSON.stringify(join(root, 'hub.lock'))});d.pragma('locking_mode = EXCLUSIVE');d.exec('BEGIN EXCLUSIVE');console.log('held');setInterval(()=>{},1000)`
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'inherit'] }
    )
    await new Promise<void>((resolve) => holder.stdout!.once('data', () => resolve()))
    expect(() => acquireHubRootLock(root)).toThrow(/already running/)
    holder.kill('SIGKILL')
    await new Promise((r) => holder.once('exit', r))
    acquireHubRootLock(root).release()
  })

  test('different roots never block each other', () => {
    const a = acquireHubRootLock(newRoot())
    const b = acquireHubRootLock(newRoot())
    a.release()
    b.release()
  })
})
