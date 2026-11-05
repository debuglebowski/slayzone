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

  it('stops reporting once stopped', async () => {
    await call(HubToComputerMethods.gitWatchStart, { watchId: 'w1', worktreePath: dir })
    await call(HubToComputerMethods.gitWatchStop, { watchId: 'w1' })
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
