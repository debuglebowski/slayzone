import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceChangesHandlers } from './workspace-changes'
import { createRoutingWorkspaceCaptureBackend } from '../../../../domains/computer-transport/src/server/workspace-changes'
import type { HandlerContext } from './types'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

it('captures on the requested computer and validates its responses through the shared contract', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'computer-workspace-')))
  roots.push(root)
  execFileSync('git', ['init', '-q'], { cwd: root })
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
  const handlers = createWorkspaceChangesHandlers(ctx, () => null)
  const targets: string[] = []
  const backend = createRoutingWorkspaceCaptureBackend({
    request: async <T>(computer: string, method: string, params?: unknown) => {
      targets.push(computer)
      return (await handlers[method](params)) as T
    }
  } as Parameters<typeof createRoutingWorkspaceCaptureBackend>[0])
  const request = { id: 'capture', scope: 'tab:1', rootPath: root, computerId: 'remote-box' }
  expect((await backend.begin(request)).status).toBe('ready')
  writeFileSync(join(root, 'shell.txt'), 'hello\n')
  expect((await backend.finish(request)).files[0]).toMatchObject({
    path: 'shell.txt',
    additions: 1
  })
  expect(targets).toEqual(['remote-box', 'remote-box'])
  await backend.discard(request)
  await expect(backend.begin({ ...request, computerId: null })).rejects.toThrow(
    'computer is unavailable'
  )
  await expect(backend.begin({ ...request, rootPath: '/' })).rejects.toThrow()
})
