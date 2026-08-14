/**
 * fs.* end-to-end contract: hub routed adapters ⇄ REAL computer handlers.
 *
 * `handlers/fs.test.ts` exercises the computer side alone and `exec-proxies.test.ts`
 * drives a fake gateway; neither can catch the two sides DISAGREEING about a wire
 * shape. That disagreement is not hypothetical here — it shipped four times in
 * the git.* and proc.* frames (`{sessionId}` vs `{id}`, `isRepo` vs `isGitRepo`,
 * `repoPath` vs `projectPath`), each invisible until the op started routing.
 *
 * The fs surface is the largest one yet added, and it is the one the directory
 * picker depends on, so it gets the same treatment: both real implementations,
 * wired to each other through the shared schemas, over real files in a tmpdir.
 *
 * The computer handler lives in `@slayzone/computer` (an app, not a dep of this
 * package), so it is loaded by path and the suite skips if unresolvable.
 *
 * @module computer/server/fs-roundtrip.test
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalWorkspaceFs } from '@slayzone/file-editor/server'
import { TypedEventEmitter } from '../shared/events'
import { ComputerNotificationMethods } from '../shared/frames'
import { createRemoteFsAdapters, type RoutingGateway } from './exec-proxies'
import type { ComputerGatewayEvents } from './hub-gateway'

const COMPUTER_ID = 'computer-1'

type FsHandlerTable = Record<string, (params: unknown) => Promise<unknown> | unknown>

/** Any call here means a routed op silently answered about the hub's disk. */
const refuseLocal = new Proxy({} as LocalWorkspaceFs, {
  get(_t, prop: string) {
    return () => {
      throw new Error(`must not fall back to local: a computerId was resolved (called ${prop})`)
    }
  }
})

function bridge(
  handlers: FsHandlerTable,
  events: TypedEventEmitter<ComputerGatewayEvents>
): RoutingGateway {
  return {
    request: async (_computerId: string, method: string, params?: unknown) => {
      const handler = handlers[method]
      if (!handler) throw new Error(`computer has no handler for ${method}`)
      return await handler(params)
    },
    events,
    listComputers: () => []
  }
}

let dir: string

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'fs-roundtrip-')))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface LoadedComputer {
  handlers: FsHandlerTable
  events: TypedEventEmitter<ComputerGatewayEvents>
}

async function loadComputerFsHandlers(roots: string[]): Promise<LoadedComputer | null> {
  let mod: { createFsHandlers: (ctx: unknown) => FsHandlerTable }
  try {
    mod = await import('../../../../apps/computer/src/handlers/fs')
  } catch {
    return null
  }
  const events = new TypedEventEmitter<ComputerGatewayEvents>()
  const handlers = mod.createFsHandlers({
    dialer: {
      notify: (method: string, params?: unknown) => {
        if (method === ComputerNotificationMethods.fsChange) {
          events.emit('fs.change', {
            computerId: COMPUTER_ID,
            ...((params ?? {}) as Record<string, never>)
          })
        }
        return true
      }
    },
    config: {
      hubUrl: 'ws://127.0.0.1:0/computers',
      name: 'roundtrip',
      allowedRoots: roots,
      capabilities: ['fs']
    },
    log: () => {}
  })
  return { handlers, events }
}

async function adaptersFor(roots: string[]) {
  const computer = await loadComputerFsHandlers(roots)
  if (!computer) return null
  return createRemoteFsAdapters({
    gateway: bridge(computer.handlers, computer.events),
    local: refuseLocal,
    newWatchId: () => 'watch-1'
  })
}

describe('fs.* hub⇄computer round trip — browse', () => {
  it('reports the computer jail as the browsable roots', async () => {
    const fs = await adaptersFor([dir])
    if (!fs) return
    const res = await fs.listRoots(COMPUTER_ID)
    expect(res.roots).toEqual([dir])
    expect(res.platform).toBe(process.platform)
  })

  it('lists a directory, marks git repos, and bounds "up" at the root', async () => {
    mkdirSync(join(dir, 'repo', '.git'), { recursive: true })
    mkdirSync(join(dir, 'plain'), { recursive: true })
    writeFileSync(join(dir, 'note.txt'), 'x')

    const fs = await adaptersFor([dir])
    if (!fs) return

    const atRoot = await fs.listDir(COMPUTER_ID, dir, { dirsOnly: true })
    expect(atRoot.entries.map((e) => e.name)).toEqual(['plain', 'repo'])
    expect(atRoot.entries.find((e) => e.name === 'repo')?.isGitRepo).toBe(true)
    expect(atRoot.parent).toBeNull()

    const below = await fs.listDir(COMPUTER_ID, join(dir, 'plain'))
    expect(below.parent).toBe(dir)
  })

  it('creates a directory on the computer and confirms it exists there', async () => {
    const fs = await adaptersFor([dir])
    if (!fs) return
    const target = join(dir, 'made', 'deep')
    expect(await fs.pathExists(COMPUTER_ID, target)).toBe(false)
    expect((await fs.mkdir(COMPUTER_ID, target)).path).toBe(target)
    expect(await fs.pathExists(COMPUTER_ID, target)).toBe(true)
  })

  // The jail is the computer's, and it must survive the round trip as a REJECTION
  // rather than an empty listing — an empty tree reads as "nothing here", which
  // is a different (and wrong) thing to tell the user than "not permitted".
  it('propagates a jail violation as an error, not an empty result', async () => {
    const inner = join(dir, 'inner')
    mkdirSync(inner, { recursive: true })
    const fs = await adaptersFor([inner])
    if (!fs) return
    await expect(fs.listDir(COMPUTER_ID, dir)).rejects.toThrow(/allowedRoots/)
  })
})

describe('fs.* hub⇄computer round trip — editor', () => {
  beforeEach(() => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const a = 1\n')
    writeFileSync(join(dir, '.gitignore'), 'secret.txt\n')
    writeFileSync(join(dir, 'secret.txt'), 'hidden')
  })

  it('reads the tree with root-relative paths and gitignore flags intact', async () => {
    const fs = await adaptersFor([dir])
    if (!fs) return
    const entries = await fs.readDir(COMPUTER_ID, dir, '')
    expect(entries.find((e) => e.name === 'src')?.path).toBe('src')
    expect(entries.find((e) => e.name === 'secret.txt')?.ignored).toBe(true)
  })

  it('round-trips a write through the wire and lands it on real disk', async () => {
    const fs = await adaptersFor([dir])
    if (!fs) return
    await fs.writeFile(COMPUTER_ID, dir, 'src/new.ts', 'const b = 2')
    expect(readFileSync(join(dir, 'src', 'new.ts'), 'utf-8')).toBe('const b = 2')
    expect(await fs.readFile(COMPUTER_ID, dir, 'src/new.ts')).toEqual({ content: 'const b = 2' })
  })

  it('carries search results and the truncated flag across the wire', async () => {
    const fs = await adaptersFor([dir])
    if (!fs) return
    const res = await fs.searchFiles(COMPUTER_ID, dir, 'export')
    expect(res.results.map((r) => r.path)).toEqual(['src/index.ts'])
    expect(res.truncated).toBe(false)
  })

  it('reports git status for a non-repo root without inventing one', async () => {
    const fs = await adaptersFor([dir])
    if (!fs) return
    expect(await fs.gitStatus(COMPUTER_ID, dir)).toEqual({ files: {}, isGitRepo: false })
  })
})

describe('fs.* hub⇄computer round trip — watch', () => {
  it('delivers a real file change from the computer watcher to the hub listener', async () => {
    const fs = await adaptersFor([dir])
    if (!fs) return

    const seen: string[] = []
    const stop = fs.watch(COMPUTER_ID, dir, (e) => seen.push(`${e.type}:${e.relPath}`))

    // Wait for THIS file's event, not merely for any event: macOS `fs.watch`
    // recursive also fires once for the watched directory itself (relPath = the
    // dir's own basename), which lands first and would satisfy a bare
    // "something arrived" check before the real change ever shows up.
    await vi.waitFor(
      () => {
        writeFileSync(join(dir, 'watched.txt'), String(seen.length))
        expect(seen).toContain('changed:watched.txt')
      },
      { timeout: 5000, interval: 100 }
    )
    stop()
  })
})
