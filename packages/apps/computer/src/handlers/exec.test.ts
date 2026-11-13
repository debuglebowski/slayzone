/**
 * The computer's git spawns go by absolute path (gitCommand, resolve-command.ts),
 * resolved against the env the child gets. Once git has been found, a git put EARLIER
 * on the same PATH is not the one that runs — a bare `git` would make the OS search
 * PATH again and run it.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { execCapture, execGit } from './exec'

const isWin = process.platform === 'win32'
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'computer-git-command-')))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function fakeGit(name: string): void {
  mkdirSync(join(dir, name), { recursive: true })
  const file = join(dir, name, 'git')
  writeFileSync(file, `#!/bin/sh\necho ${name}\n`)
  chmodSync(file, 0o755)
}

describe.skipIf(isWin)('computer git spawns', () => {
  it('keep the resolved git while it exists, for an explicit env and for process.env', async () => {
    fakeGit('late')
    const env = { ...process.env, PATH: [join(dir, 'early'), join(dir, 'late')].join(delimiter) }
    expect((await execCapture('git', ['--version'], { env })).stdout.trim()).toBe('late')
    fakeGit('early')
    expect((await execCapture('git', ['--version'], { env })).stdout.trim()).toBe('late')

    // execGit spawns with the computer's own env.
    const saved = process.env.PATH
    process.env.PATH = [join(dir, 'early2'), join(dir, 'late')].join(delimiter)
    try {
      expect((await execGit(['--version'], dir)).trim()).toBe('late')
      fakeGit('early2')
      expect((await execGit(['--version'], dir)).trim()).toBe('late')
    } finally {
      process.env.PATH = saved
    }
  })
})
