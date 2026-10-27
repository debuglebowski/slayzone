/**
 * Untracked-file diffs: one call for a batch of new files (the panel used to issue one
 * RPC + one git per file, all at once — a fresh unignored dir of 500 files meant 500
 * concurrent gits), with a cap on concurrent processes. `git diff --no-index` exits 1
 * when the files differ, which is its normal answer — not a failure in diagnostics.
 *
 * Run with: pnpm exec vitest run --config packages/apps/app/vitest.config.ts \
 *   packages/domains/worktrees/src/server/untracked-diffs.test.ts
 */
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const recorded = vi.hoisted(() => [] as Array<{ level: string; event: string }>)
vi.mock('@slayzone/diagnostics/server', () => ({
  recordDiagnosticEvent: (e: { level: string; event: string }) => recorded.push(e)
}))

const { getUntrackedFileDiff, getUntrackedFileDiffs } = await import('./git-worktree')

const FILES = 20
let repo: string

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'untracked-diffs-'))
  execSync('git init -q', { cwd: repo })
  for (let i = 0; i < FILES; i++) writeFileSync(join(repo, `n${i}.txt`), `line ${i}\n`)
})
afterAll(() => rmSync(repo, { recursive: true, force: true }))
beforeEach(() => {
  recorded.length = 0
})

describe('getUntrackedFileDiffs', () => {
  it('returns each file’s patch, same as the single-file read', async () => {
    const paths = Array.from({ length: FILES }, (_, i) => `n${i}.txt`)
    const batch = await getUntrackedFileDiffs(repo, paths)
    expect(Object.keys(batch).sort()).toEqual([...paths].sort())
    expect(batch['n3.txt']).toBe(await getUntrackedFileDiff(repo, 'n3.txt'))
    expect(batch['n3.txt']).toContain('+line 3')
  })

  it('omits a file that cannot be read instead of failing the batch', async () => {
    const batch = await getUntrackedFileDiffs(repo, ['n1.txt', 'missing.txt'])
    expect(Object.keys(batch)).toEqual(['n1.txt'])
  })

  it('logs the expected exit 1 as a command, not a failure', async () => {
    await getUntrackedFileDiff(repo, 'n0.txt')
    expect(recorded.map((e) => e.event)).toEqual(['git.command'])
  })
})
