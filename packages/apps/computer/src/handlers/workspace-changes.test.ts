/**
 * workspaceChanges.* hub⇄computer round trip: the hub's routing capture backend drives
 * the REAL computer handlers, and every reply is validated through the shared contract.
 *
 * The Git work the handlers delegate to (snapshots and diffs, `git rev-parse
 * --show-toplevel`) is injected: what it does is covered by agent-turns'
 * workspace-capture.test.ts on real repositories. Here it would only add ~20 process
 * spawns, the wall-clock cost that made this test time out under load.
 */
import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceCaptureRequest, WorkspaceCaptureResult } from '@slayzone/terminal-contracts'
import { createWorkspaceChangesHandlers, type WorkspaceChangesDeps } from './workspace-changes'
import { createRoutingWorkspaceCaptureBackend } from '../../../../domains/computer-transport/src/server/workspace-changes'
import type { HandlerContext } from './types'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

const shellDiff: WorkspaceCaptureResult = {
  status: 'complete',
  files: [
    {
      path: 'shell.txt',
      kind: 'added',
      additions: 1,
      deletions: 0,
      binary: false,
      diff: 'diff --git a/shell.txt b/shell.txt\n+hello\n'
    }
  ]
}

it('captures on the requested computer and validates its responses through the shared contract', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'computer-workspace-')))
  roots.push(root)
  const nested = join(root, 'src')
  mkdirSync(nested)
  const ctx: HandlerContext = {
    config: {
      hubUrl: 'ws://localhost',
      name: 'test',
      allowedRoots: [root],
      capabilities: ['proc']
    },
    log: () => {},
    dialer: { notify: () => true }
  }
  // What the computer's Git reports per folder: `root` is a repository, `nested` sits
  // inside it, and `outside` belongs to a repository above the allowed roots.
  const outside = join(root, 'outside')
  mkdirSync(outside)
  const toplevels = new Map<string, string | null>([
    [root, root],
    [nested, root],
    [outside, '/']
  ])
  const seen: Array<[string, WorkspaceCaptureRequest]> = []
  const deps: WorkspaceChangesDeps = {
    gitToplevel: async (cwd) => toplevels.get(cwd) ?? null,
    captures: {
      begin: async (request) => {
        seen.push(['begin', request])
        return { status: 'ready' }
      },
      finish: async (request) => {
        seen.push(['finish', request])
        return shellDiff
      },
      discard: async (request) => {
        seen.push(['discard', request])
      }
    }
  }
  const handlers = createWorkspaceChangesHandlers(ctx, () => null, deps)
  const targets: string[] = []
  const backend = createRoutingWorkspaceCaptureBackend({
    request: async <T>(computer: string, method: string, params?: unknown) => {
      targets.push(computer)
      return (await handlers[method](params)) as T
    }
  } as Parameters<typeof createRoutingWorkspaceCaptureBackend>[0])
  // Asked from a folder inside the repository: the capture runs on the repository's root.
  const request = { id: 'capture', scope: 'tab:1', rootPath: nested, computerId: 'remote-box' }
  expect((await backend.begin(request)).status).toBe('ready')
  expect((await backend.finish(request)).files[0]).toMatchObject({
    path: 'shell.txt',
    additions: 1
  })
  expect(targets).toEqual(['remote-box', 'remote-box'])
  await backend.discard(request)
  expect(seen.map(([op, r]) => [op, r.id, r.scope, r.rootPath])).toEqual([
    ['begin', 'capture', 'tab:1', root],
    ['finish', 'capture', 'tab:1', root],
    ['discard', 'capture', 'tab:1', root]
  ])
  await expect(backend.begin({ ...request, computerId: null })).rejects.toThrow(
    'computer is unavailable'
  )
  await expect(backend.begin({ ...request, rootPath: '/' })).rejects.toThrow()
  // Git walking up to a repository above the allowed roots is refused, as is no repository.
  await expect(backend.begin({ ...request, rootPath: outside })).rejects.toThrow('outside')
  toplevels.set(root, null)
  await expect(backend.begin({ ...request, rootPath: root })).rejects.toThrow(
    'not an accessible Git repository'
  )
  expect(seen).toHaveLength(3)
})
