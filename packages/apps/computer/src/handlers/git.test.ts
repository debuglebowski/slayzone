import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitIsGitRepoResultSchema } from '@slayzone/computer-transport/shared'
import type { ComputerConfig } from '../config'
import { GitMethods, createGitHandlers } from './git'
import type { ComputerDialer } from './types'

const dialer: ComputerDialer = { notify: () => true }

function ctxWithRoots(roots: string[]) {
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
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
  dir = mkdtempSync(join(tmpdir(), 'computer-git-'))
  // Canonicalize so containment holds on macOS (/var → /private/var).
  roots = [realpathSync(tmpdir())]
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createGitHandlers — git.isGitRepo', () => {
  it('is false for a bare directory and true after git init', async () => {
    const handlers = createGitHandlers(ctxWithRoots(roots))
    // Assert through the SHARED result schema, not a hand-written literal: this
    // test previously encoded the computer's own `{isRepo}` shape, so it passed while
    // the hub (parsing `{isGitRepo}`) rejected every reply.
    expect(gitIsGitRepoResultSchema.parse(await handlers['git.isGitRepo']({ path: dir }))).toEqual({
      isGitRepo: false
    })
    git(['init'], dir)
    expect(gitIsGitRepoResultSchema.parse(await handlers['git.isGitRepo']({ path: dir }))).toEqual({
      isGitRepo: true
    })
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
    expect(await handlers['git.getCurrentBranch']({ repoPath: dir })).toEqual({
      branch: 'my-feature'
    })
  })

  it('returns null branch for a non-repo path (inside an allowed root)', async () => {
    const handlers = createGitHandlers(ctxWithRoots(roots))
    expect(await handlers['git.getCurrentBranch']({ repoPath: dir })).toEqual({ branch: null })
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
    // The worktree setup script inherits the computer's process.env. SlayZone
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

describe('createGitHandlers — git.removeWorktree keeps the branch unless asked', () => {
  // The hub's archive / delete / startup-purge paths remove the worktree and say nothing
  // about its branch. v0.35.0 kept the branch ("Branch is kept" in the Worktrees UI); this
  // handler force-deleted it (`git branch -D`), so unmerged, unpushed commits became
  // dangling objects. Deleting a branch is now an explicit request on the frame.
  function repoWithWorktree(): { repo: string; wt: string } {
    const repo = join(realpathSync(dir), 'repo')
    mkdirSync(repo)
    git(['init'], repo)
    git(['config', 'user.email', 'test@example.com'], repo)
    git(['config', 'user.name', 'Test'], repo)
    git(['commit', '--allow-empty', '-m', 'init'], repo)
    const wt = join(realpathSync(dir), 'wt')
    git(['worktree', 'add', '-b', 'feature-x', wt], repo)
    // An unmerged commit that exists ONLY on the branch.
    writeFileSync(join(wt, 'work.txt'), 'unmerged work')
    git(['add', '.'], wt)
    git(['commit', '-m', 'unmerged work'], wt)
    return { repo, wt }
  }
  const branches = (repo: string): string =>
    execFileSync('git', ['branch', '--list', 'feature-x'], { cwd: repo, encoding: 'utf8' }).trim()

  it('removes the worktree and KEEPS its branch by default', async () => {
    const { repo, wt } = repoWithWorktree()
    const handlers = createGitHandlers(ctxWithRoots(roots))
    const res = (await handlers[GitMethods.removeWorktree]({
      projectPath: repo,
      worktreePath: wt
    })) as { branchDeleted?: boolean }
    expect(res.branchDeleted).not.toBe(true)
    expect(branches(repo)).toContain('feature-x')
  })

  it('deletes the branch only when deleteBranch is true', async () => {
    const { repo, wt } = repoWithWorktree()
    const handlers = createGitHandlers(ctxWithRoots(roots))
    const res = (await handlers[GitMethods.removeWorktree]({
      projectPath: repo,
      worktreePath: wt,
      deleteBranch: true
    })) as { branchDeleted?: boolean }
    expect(res.branchDeleted).toBe(true)
    expect(branches(repo)).toBe('')
  })
})
