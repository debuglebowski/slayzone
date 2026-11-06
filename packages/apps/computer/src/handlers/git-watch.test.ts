/**
 * The git panel's live refresh: the computer watches the checkout it holds and
 * reports each (debounced) change as a `git-watch` event, correlated by the hub's
 * watch id. Stop ends it; a path outside the jail is refused.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ComputerNotificationMethods,
  GIT_WATCH_EVENT,
  HubToComputerMethods
} from '@slayzone/computer-transport/shared'
import type { ComputerConfig } from '../config'
import { createGitOpHandlers } from './git-op'

const sent: Array<{ method: string; params: unknown }> = []
function ctx() {
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: [realpathSync(tmpdir())],
    capabilities: ['git']
  }
  return {
    dialer: {
      notify: (method: string, params?: unknown) => {
        sent.push({ method, params })
        return true
      }
    },
    config,
    log: () => {}
  }
}

let dir: string
let handlers: ReturnType<typeof createGitOpHandlers>
const call = (method: string, params: unknown) =>
  Promise.resolve((handlers[method] as (p: unknown) => unknown)(params))
const watchEvents = () =>
  sent
    .filter(
      (s) =>
        s.method === ComputerNotificationMethods.event &&
        (s.params as { name: string }).name === GIT_WATCH_EVENT
    )
    .map((s) => (s.params as { payload: unknown }).payload)

beforeEach(() => {
  sent.length = 0
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'computer-git-watch-')))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  handlers = createGitOpHandlers(ctx())
})

afterEach(async () => {
  await call(HubToComputerMethods.gitWatchStop, { watchId: 'w1' }).catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('git.watchStart / git.watchStop', () => {
  it('reports a change in the checkout under the hub’s watch id', async () => {
    await call(HubToComputerMethods.gitWatchStart, { watchId: 'w1', worktreePath: dir })
    writeFileSync(join(dir, 'a.txt'), 'x')
    await vi.waitFor(
      () =>
        expect(watchEvents()).toContainEqual(
          expect.objectContaining({ watchId: 'w1', kind: 'changed' })
        ),
      // fs events lag on a loaded machine.
      { timeout: 8000 }
    )
  }, 12_000)

  // Round-9 Q4: on macOS a recursive fs.watch returns before its FSEvents stream is
  // live, and a change in that window is DROPPED, not delayed — the git panel then
  // showed stale state until the next change or the 30 s fallback poll. watchStart
  // now answers only once the watch is live: a change made right after it is seen,
  // every time.
  it('a change made right after watchStart is never missed (25 fresh watches, no delay)', async () => {
    // Started side by side, as a window full of git panels does: FSEvents start-up
    // takes longest then, so the dead window is widest.
    const repos = Array.from({ length: 25 }, () => {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), 'computer-git-watch-race-')))
      execFileSync('git', ['init', '-q'], { cwd: repo })
      return repo
    })
    // Only an event AFTER the write counts: one sent as the watch starts says nothing
    // about whether the write itself was seen.
    const wroteAt = new Map<string, number>()
    try {
      await Promise.all(
        repos.map(async (repo, i) => {
          await call(HubToComputerMethods.gitWatchStart, {
            watchId: `race-${i}`,
            worktreePath: repo
          })
          wroteAt.set(`race-${i}`, sent.length)
          writeFileSync(join(repo, 'a.txt'), String(i))
        })
      )
      // A change that was seen is reported within the 200 ms debounce; give it ample time.
      await new Promise((r) => setTimeout(r, 2_500))
      const seen = new Set<string>()
      sent.forEach((m, at) => {
        const e = m.params as { name?: string; payload?: { watchId: string; kind: string } }
        if (m.method !== ComputerNotificationMethods.event || e.name !== GIT_WATCH_EVENT) return
        const p = e.payload
        if (p && p.kind === 'changed' && at >= (wroteAt.get(p.watchId) ?? Infinity))
          seen.add(p.watchId)
      })
      const misses = repos.map((_, i) => `race-${i}`).filter((id) => !seen.has(id))
      expect(misses, `missed: ${misses.join(', ')}`).toEqual([])
    } finally {
      for (let i = 0; i < repos.length; i++) {
        await call(HubToComputerMethods.gitWatchStop, { watchId: `race-${i}` })
        rmSync(repos[i] as string, { recursive: true, force: true })
      }
    }
  }, 120_000)

  it('stops reporting once stopped', async () => {
    await call(HubToComputerMethods.gitWatchStart, { watchId: 'w1', worktreePath: dir })
    await call(HubToComputerMethods.gitWatchStop, { watchId: 'w1' })
    // The start's own change (see `ready`) came before the stop; none may come after.
    sent.length = 0
    writeFileSync(join(dir, 'b.txt'), 'x')
    await new Promise((r) => setTimeout(r, 600))
    expect(watchEvents()).toEqual([])
  })

  // The hub that asked is gone: its watch ids mean nothing to the next one (it
  // starts its own), so each reconnect used to leave one more recursive fs.watch
  // open forever. A disconnect closes them all.
  it('a hub disconnect closes every watch it started', async () => {
    const onDisconnect: Array<() => void> = []
    handlers = createGitOpHandlers(ctx(), { onHubDisconnected: (cb) => onDisconnect.push(cb) })
    await call(HubToComputerMethods.gitWatchStart, { watchId: 'w1', worktreePath: dir })
    await call(HubToComputerMethods.gitWatchStart, { watchId: 'w9', worktreePath: dir })
    for (const cb of onDisconnect) cb()
    sent.length = 0 // the starts' own changes came before the disconnect
    writeFileSync(join(dir, 'c.txt'), 'x')
    await new Promise((r) => setTimeout(r, 800))
    expect(watchEvents(), 'nothing reported after the disconnect').toEqual([])
  })

  it('refuses a checkout outside its folders', async () => {
    await expect(
      call(HubToComputerMethods.gitWatchStart, { watchId: 'w2', worktreePath: '/etc' })
    ).rejects.toThrow(/outside/)
  })
})
