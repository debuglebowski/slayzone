import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Command } from 'commander'
const { post } = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('../api', () => ({ apiGet: vi.fn(), apiPost: post }))
vi.mock('../db', () => ({ notifyApp: vi.fn() }))
import { initCommand } from './init'
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
it('writes instructions to explicit local path instead of hub project path', async () => {
  const remote = mkdtempSync(join(tmpdir(), 'slay-init-remote-'))
  const hub = mkdtempSync(join(tmpdir(), 'slay-init-hub-'))
  dirs.push(remote, hub)
  post.mockResolvedValue({
    data: {
      project: { id: 'p', name: 'Project', path: hub },
      providers: ['codex'],
      stats: { installed: 0, updated: 0, skipped: 0 },
      skills: []
    }
  })
  const cmd = new Command().exitOverride().addCommand(initCommand())
  await cmd.parseAsync(['init', '--project', 'p', '--path', remote], { from: 'user' })
  expect(readFileSync(join(remote, 'AGENTS.md'), 'utf8')).toContain('slay')
  expect(existsSync(join(hub, 'AGENTS.md'))).toBe(false)
})
