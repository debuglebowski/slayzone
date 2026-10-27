import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubToComputerMethods } from '@slayzone/computer-transport/shared'
import type { ComputerConfig } from './config'
import { createGhHandlers } from './handlers/gh'
import { GitMethods, createGitHandlers } from './handlers/git'
import { adoptLoginShellPath } from './login-shell-path'

const isWin = process.platform === 'win32'
/** What macOS hands an app opened from the Dock/Finder (launchd's default). */
const BARE_GUI_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

let dir: string
/** A dir only the user's login shell puts on PATH — stands in for /opt/homebrew/bin. */
let shellOnlyBin: string
let savedPath: string | undefined

function script(path: string, lines: string[]): string {
  writeFileSync(path, ['#!/bin/sh', ...lines].join('\n') + '\n')
  chmodSync(path, 0o755)
  return path
}

/** A login shell with noisy startup files that adds `shellOnlyBin` to PATH. */
function noisyLoginShell(): string {
  return script(join(dir, 'zsh'), [
    'echo "gitstatus: initializing"',
    'while [ "$1" != "-c" ]; do shift; done',
    'shift',
    `PATH="${shellOnlyBin}:$PATH"`,
    'eval "$1"'
  ])
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'computer-login-path-')))
  shellOnlyBin = join(dir, 'brew-bin')
  mkdirSync(shellOnlyBin)
  savedPath = process.env.PATH
})
afterEach(() => {
  process.env.PATH = savedPath
  rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(isWin)('adoptLoginShellPath', () => {
  it('puts the login-shell PATH first and keeps inherited entries', async () => {
    const env: NodeJS.ProcessEnv = { PATH: `${BARE_GUI_PATH}:/inherited/only` }
    const adopted = await adoptLoginShellPath({ env, shell: noisyLoginShell() })
    const entries = env.PATH!.split(':')
    expect(entries[0]).toBe(shellOnlyBin)
    expect(entries).toContain('/inherited/only')
    expect(entries.some((e) => e.includes('gitstatus'))).toBe(false)
    expect(adopted?.added).toEqual([shellOnlyBin])
  })

  it('keeps the inherited PATH when the shell probe fails', async () => {
    const env: NodeJS.ProcessEnv = { PATH: BARE_GUI_PATH }
    const broken = script(join(dir, 'zsh'), ['exit 1'])
    expect(await adoptLoginShellPath({ env, shell: broken })).toBeNull()
    expect(env.PATH).toBe(BARE_GUI_PATH)
  })
})

describe.skipIf(isWin)('a computer started with the bare GUI PATH', () => {
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: [],
    capabilities: ['git']
  }
  const ctx = () => ({
    dialer: { notify: () => true },
    config: { ...config, allowedRoots: [dir] },
    log: () => {}
  })

  // The PR panel: `gh` lives where only the login shell looks (Homebrew).
  it('runs gh from the login-shell PATH once adopted', async () => {
    script(join(shellOnlyBin, 'gh'), ['echo "gh ran: $*"'])
    // An empty dir stands in for the bare PATH: the real one has a system gh on
    // Linux CI (/usr/bin/gh), and running it unauthenticated can outlast the test.
    const bareBin = join(dir, 'bare-bin')
    mkdirSync(bareBin)
    process.env.PATH = bareBin
    const gh = createGhHandlers(ctx())[HubToComputerMethods.ghExec]
    expect(await gh({ args: ['pr', 'list'], cwd: dir })).not.toMatchObject({
      stdout: 'gh ran: pr list\n'
    })

    await adoptLoginShellPath({ env: process.env, shell: noisyLoginShell() })
    expect(await gh({ args: ['pr', 'list'], cwd: dir })).toEqual({
      status: 0,
      stdout: 'gh ran: pr list\n',
      stderr: ''
    })
  })

  // Git LFS: a repo's hooks call a tool installed alongside git, not by SlayZone.
  // A stand-in name, not `git-lfs`: a real one on the machine's PATH (/usr/bin on
  // Linux CI) would pass the hook before the login-shell PATH is adopted.
  it('creates a worktree whose post-checkout hook needs a login-shell tool', async () => {
    script(join(shellOnlyBin, 'login-shell-lfs'), ['exit 0'])
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync(
      'git',
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=T',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init'
      ],
      { cwd: repo }
    )
    script(join(repo, '.git', 'hooks', 'post-checkout'), [
      'command -v login-shell-lfs >/dev/null 2>&1 || { echo >&2 "login-shell-lfs was not found on your path"; exit 2; }'
    ])
    const create = createGitHandlers(ctx())[GitMethods.createWorktree]

    process.env.PATH = BARE_GUI_PATH
    await expect(
      create({ repoPath: repo, worktreePath: join(dir, 'wt-before'), branch: 'before' })
    ).rejects.toThrow(/login-shell-lfs was not found/)

    await adoptLoginShellPath({ env: process.env, shell: noisyLoginShell() })
    await expect(
      create({ repoPath: repo, worktreePath: join(dir, 'wt-after'), branch: 'after' })
    ).resolves.toEqual({ ok: true })
  })
})
