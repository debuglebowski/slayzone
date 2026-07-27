import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunnerConfig } from '../config'
import { GitMethods, createGitHandlers } from './git'
import type { RunnerDialer } from './types'

const dialer: RunnerDialer = { notify: () => true }

function ctxWithRoots(roots: string[]) {
  const config: RunnerConfig = {
    hubUrl: 'ws://localhost:0/runners',
    name: 'test',
    allowedRoots: roots,
    capabilities: ['git']
  }
  return { dialer, config, log: () => {} }
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

let dir: string
let roots: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runner-git-'))
  // Canonicalize so containment holds on macOS (/var → /private/var).
  roots = [realpathSync(tmpdir())]
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createGitHandlers — git.isGitRepo', () => {
  it('is false for a bare directory and true after git init', async () => {
    const handlers = createGitHandlers(ctxWithRoots(roots))
    expect(await handlers['git.isGitRepo']({ path: dir })).toEqual({ isRepo: false })
    git(['init'], dir)
    expect(await handlers['git.isGitRepo']({ path: dir })).toEqual({ isRepo: true })
  })
})

describe('createGitHandlers — git.getCurrentBranch', () => {
  it('returns the checked-out branch name', async () => {
    git(['init'], dir)
    git(['config', 'user.email', 'test@example.com'], dir)
    git(['config', 'user.name', 'Test'], dir)
    git(['commit', '--allow-empty', '-m', 'init'], dir)
    git(['checkout', '-b', 'my-feature'], dir)

    const handlers = createGitHandlers(ctxWithRoots(roots))
    expect(await handlers['git.getCurrentBranch']({ path: dir })).toEqual({ branch: 'my-feature' })
  })

  it('returns null branch for a non-repo path (inside an allowed root)', async () => {
    const handlers = createGitHandlers(ctxWithRoots(roots))
    expect(await handlers['git.getCurrentBranch']({ path: dir })).toEqual({ branch: null })
  })
})

describe('createGitHandlers — allowedRoots guard', () => {
  it('rejects a path outside every allowed root', async () => {
    const handlers = createGitHandlers(ctxWithRoots(roots))
    // `/` is guaranteed to sit outside a tmpdir root.
    await expect(handlers['git.isGitRepo']({ path: '/' })).rejects.toThrow(/allowedRoots/)
  })

  it('rejects a ../ traversal attempt', async () => {
    const handlers = createGitHandlers(ctxWithRoots([realpathSync(dir)]))
    await expect(handlers['git.isGitRepo']({ path: join(dir, '..', 'escape') })).rejects.toThrow(
      /allowedRoots/
    )
  })
})

describe('createGitHandlers — runWorktreeSetupScript env sanitize', () => {
  it('sanitizes the inherited process.env base: strips SlayZone infra/secret, keeps PATH + WORKTREE_PATH overlay', async () => {
    // The worktree setup script inherits the runner's process.env. SlayZone
    // infra/secret must NOT leak into it; the WORKTREE_PATH/REPO_PATH/SOURCE_BRANCH
    // overlay + user env (PATH) MUST survive.
    const saved: Record<string, string | undefined> = {}
    const inject: Record<string, string> = {
      SLAYZONE_HUB_TOKEN: 'inherited-secret',
      SLAYZONE_HUB_ADDRESS: 'hub.example:8443',
      SLAYZONE_FUTURE_UNLISTED: 'fail-closed',
      ELECTRON_RUN_AS_NODE: '1'
    }
    for (const [k, v] of Object.entries(inject)) {
      saved[k] = process.env[k]
      process.env[k] = v
    }
    try {
      const wt = realpathSync(dir)
      mkdirSync(join(wt, '.slay'), { recursive: true })
      writeFileSync(
        join(wt, '.slay', 'worktree-setup.sh'),
        '#!/bin/sh\n' +
          'echo TOK=[$SLAYZONE_HUB_TOKEN]\n' +
          'echo ADDR=[$SLAYZONE_HUB_ADDRESS]\n' +
          'echo FUT=[$SLAYZONE_FUTURE_UNLISTED]\n' +
          'echo ERAN=[$ELECTRON_RUN_AS_NODE]\n' +
          'echo WT=[$WORKTREE_PATH]\n' +
          'echo PATHSET=[${PATH:+yes}]\n',
        { mode: 0o755 }
      )
      const handlers = createGitHandlers(ctxWithRoots([realpathSync(tmpdir())]))
      const res = (await handlers[GitMethods.runWorktreeSetupScript]({
        worktreePath: wt,
        repoPath: wt
      })) as { ran: boolean; success?: boolean; output?: string }
      expect(res.ran).toBe(true)
      expect(res.success).toBe(true)
      const out = res.output ?? ''
      expect(out).toContain('TOK=[]')
      expect(out).toContain('ADDR=[]')
      expect(out).toContain('FUT=[]')
      expect(out).toContain('ERAN=[]')
      expect(out).toContain(`WT=[${wt}]`)
      expect(out).toContain('PATHSET=[yes]')
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})
