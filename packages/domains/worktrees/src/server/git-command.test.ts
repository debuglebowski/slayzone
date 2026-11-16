/**
 * The hub's git spawns go by absolute path (gitCommand, resolve-command.ts), resolved
 * against the PATH the child actually gets (login-shell PATH merged in). Seen from
 * outside: once git has been found, a git put EARLIER on the same PATH is not the one
 * that runs — a bare `git` would make the OS search PATH again and run it.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configureGitExec, execAsync, hubSpawn, hubSpawnSync } from './exec-async'

const isWin = process.platform === 'win32'
let dir = ''

function fakeGit(name: string): void {
  mkdirSync(join(dir, name), { recursive: true })
  const file = join(dir, name, 'git')
  writeFileSync(file, `#!/bin/sh\necho ${name}\n`)
  chmodSync(file, 0o755)
}

function output(child: ReturnType<typeof hubSpawn>): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.on('close', () => resolve(out.trim()))
  })
}

beforeAll(() => {
  if (isWin) return
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'hub-git-command-')))
  fakeGit('late')
  // Each spawn below gets this login-shell PATH in front of the inherited one.
  const pathList = [join(dir, 'early'), join(dir, 'late')].join(delimiter)
  configureGitExec({ loginShellPath: () => pathList, refuse: () => {} })
})
afterAll(() => {
  configureGitExec(null)
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(isWin)('hub git spawns', () => {
  it('spawn by absolute path, and keep it while that git exists', async () => {
    const first = hubSpawn('git', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    expect(first.spawnfile).toBe(join(dir, 'late', 'git'))
    expect(await output(first)).toBe('late')

    fakeGit('early')
    const again = hubSpawn('git', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    expect(await output(again)).toBe('late')
    expect(String(hubSpawnSync('git', ['--version'], { encoding: 'utf8' }).stdout).trim()).toBe(
      'late'
    )
    expect((await execAsync('git', ['--version'], { cwd: dir })).stdout.trim()).toBe('late')
  })

  it('a command other than git is left to the OS', () => {
    const child = hubSpawn('true', [], { stdio: 'ignore' })
    expect(child.spawnfile).toBe('true')
  })
})
