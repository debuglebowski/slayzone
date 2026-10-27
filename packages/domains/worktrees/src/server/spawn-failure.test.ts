/**
 * A process the hub cannot START (fd exhaustion, binary missing) must be loud: logged
 * to diagnostics and reported as an error — never mistaken for the command's answer.
 * An exhausted hub used to make `isGitRepo` say "not a git repository" with nothing
 * in diagnostics, because `execAsync`'s spawn-error path logged nothing.
 *
 * Run with: pnpm exec vitest run --config packages/apps/app/vitest.config.ts \
 *   packages/domains/worktrees/src/server/spawn-failure.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const recorded = vi.hoisted(() => [] as Array<{ level: string; event: string; message?: string }>)
vi.mock('@slayzone/diagnostics/server', () => ({
  recordDiagnosticEvent: (e: { level: string; event: string; message?: string }) => recorded.push(e)
}))
// No login-shell PATH: with process.env.PATH pointed at nothing, `git` cannot start.
vi.mock('@slayzone/terminal/server', () => ({ getEnrichedPath: () => '' }))

const { execAsync } = await import('./exec-async')
const { isGitRepo } = await import('./git-worktree')

let dir: string
let savedPath: string | undefined

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'spawn-failure-'))
  savedPath = process.env.PATH
})
afterAll(() => {
  process.env.PATH = savedPath
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  recorded.length = 0
  process.env.PATH = savedPath
})

describe('execAsync — spawn failure', () => {
  it('reports spawnError and records a diagnostic event', async () => {
    const result = await execAsync('slz-definitely-not-a-binary', [], { cwd: dir })
    expect(result.spawnError).toMatch(/ENOENT/)
    expect(recorded).toContainEqual(
      expect.objectContaining({ level: 'error', event: 'git.spawn_failed' })
    )
  })

  it('a command that ran leaves spawnError unset', async () => {
    const result = await execAsync('git', ['--version'], { cwd: dir })
    expect(result.status).toBe(0)
    expect(result.spawnError).toBeUndefined()
  })
})

describe('isGitRepo', () => {
  it('is false for a directory that is not a repo', async () => {
    expect(await isGitRepo(dir)).toBe(false)
  })

  it('is false for a path that does not exist', async () => {
    expect(await isGitRepo(join(dir, 'missing'))).toBe(false)
  })

  it('throws when git cannot be started, instead of answering false', async () => {
    process.env.PATH = join(dir, 'empty-bin')
    await expect(isGitRepo(dir)).rejects.toThrow(/could not start git/i)
  })
})
