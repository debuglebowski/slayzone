import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Real git, but hermetic: no system or user git config (HOME is a temp dir, the
 * global config an empty file), and one known git binary — resolved once from the
 * inherited PATH and linked into its own dir — so the test doesn't run through
 * whatever shim `/usr/bin/git` is. Returns the dir to put on PATH for git.
 */
function isolateGit(): string {
  const home = join(dir, 'home')
  mkdirSync(home)
  const globalConfig = join(dir, 'gitconfig')
  writeFileSync(globalConfig, '')
  vi.stubEnv('HOME', home)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
  const git = execFileSync('/bin/sh', ['-c', 'command -v git'], {
    env: { PATH: savedPath ?? '' },
    encoding: 'utf-8'
  }).trim()
  const gitBin = join(dir, 'git-bin')
  mkdirSync(gitBin)
  symlinkSync(git, join(gitBin, 'git'))
  return gitBin
}

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

  it('merges an injected probe result the same way, without starting a shell', async () => {
    const env: NodeJS.ProcessEnv = { PATH: `${BARE_GUI_PATH}:/inherited/only` }
    const adopted = await adoptLoginShellPath({
      env,
      probe: async () => `${shellOnlyBin}:${BARE_GUI_PATH}`
    })
    const entries = env.PATH!.split(':')
    expect(entries[0]).toBe(shellOnlyBin)
    expect(entries).toContain('/inherited/only')
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
  // The login-shell probe itself is covered above; here it is a fixed answer, so the
  // only real processes are git's.
  it('creates a worktree whose post-checkout hook needs a login-shell tool', async () => {
    script(join(shellOnlyBin, 'login-shell-lfs'), ['exit 0'])
    const gitBin = isolateGit()
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: repo, env: { ...process.env, PATH: gitBin } })
    git(['init', '-q'])
    git([
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=T',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init'
    ])
    script(join(repo, '.git', 'hooks', 'post-checkout'), [
      'command -v login-shell-lfs >/dev/null 2>&1 || { echo >&2 "login-shell-lfs was not found on your path"; exit 2; }'
    ])
    const create = createGitHandlers(ctx())[GitMethods.createWorktree]

    const guiPath = `${gitBin}:${BARE_GUI_PATH}`
    process.env.PATH = guiPath
    await expect(
      create({ repoPath: repo, worktreePath: join(dir, 'wt-before'), branch: 'before' })
    ).rejects.toThrow(/login-shell-lfs was not found/)

    await adoptLoginShellPath({
      env: process.env,
      probe: async () => `${shellOnlyBin}:${guiPath}`
    })
    await expect(
      create({ repoPath: repo, worktreePath: join(dir, 'wt-after'), branch: 'after' })
    ).resolves.toEqual({ ok: true })
  })
})
