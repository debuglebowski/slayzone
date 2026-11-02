import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createSlayHandlers } from './slay'
import type { HandlerContext } from './types'

const exec = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: exec }))
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  exec.mockReset()
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'slay-remote-'))
  dirs.push(root)
  const projectPath = join(root, 'repo')
  mkdirSync(projectPath)
  const ctx = { config: { allowedRoots: [root] }, hubAddress: 'remote-hub:1234' } as HandlerContext
  return { ctx, root, projectPath, handlers: createSlayHandlers(ctx) }
}
it('checks instruction files on the computer', async () => {
  const { projectPath, handlers } = fixture()
  writeFileSync(join(projectPath, 'AGENTS.md'), 'Use slay for tasks')
  await expect(handlers['slay.checkConfigured']({ projectPath })).resolves.toEqual({
    configured: true
  })
})
it('refuses check and setup outside allowed roots', async () => {
  const { handlers } = fixture()
  for (const method of ['slay.checkConfigured', 'slay.setup']) {
    await expect(handlers[method]({ projectPath: '/etc' })).rejects.toThrow()
  }
  expect(exec).not.toHaveBeenCalled()
})
it('runs setup on computer with its hub address and quoted project id', async () => {
  const { projectPath, handlers } = fixture()
  exec.mockImplementation((_file, _args, _opts, cb) => cb(null, '', ''))
  await expect(handlers['slay.setup']({ projectPath, projectId: 'project-1' })).resolves.toEqual({
    ok: true
  })
  const [file, args, options] = exec.mock.calls[0]
  expect(typeof file).toBe('string')
  expect(args.at(-1)).toContain("init --project 'project-1'")
  expect(args.at(-1)).toContain('--path')
  expect(options.cwd).toBe(realpathSync(projectPath))
  expect(options.env.SLAYZONE_HUB_ADDRESS).toBe('remote-hub:1234')
})

it('uses a temporary relay capability and revokes it after failed setup', async () => {
  const { ctx, projectPath, handlers } = fixture()
  const revoke = vi.fn()
  ctx.cliRelay = {
    url: 'http://127.0.0.1:1234',
    issue: () => ({ token: 'test-capability', revoke }),
    disconnect: vi.fn(),
    close: vi.fn()
  }
  exec.mockImplementation((_file, _args, _opts, cb) => cb(new Error('setup failed')))
  expect(await handlers['slay.setup']({ projectPath })).toEqual({
    ok: false,
    error: 'setup failed'
  })
  const env = exec.mock.calls[0][2].env
  expect(env.SLAYZONE_CLI_RELAY_ADDRESS).toBe('127.0.0.1:1234')
  expect(env.SLAYZONE_CLI_RELAY_TOKEN).toBe('test-capability')
  expect(env.SLAYZONE_HUB_TOKEN).toBeUndefined()
  expect(revoke).toHaveBeenCalledTimes(1)
})
