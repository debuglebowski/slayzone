/**
 * worktrees tRPC router contract tests.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   --experimental-loader ./packages/shared/test-utils/loader.ts \
 *   packages/shared/transport/src/server/routers/worktrees.test.ts
 *
 * Two halves:
 *  1. Watcher subscriptions — cover the streaming procs nothing else touches
 *     (forward every getGitWatcher() emit, teardown removes their listener).
 *  2. Req/res procs — ports the git/worktree handler contract coverage from the
 *     now-deleted IPC handler tests onto the router `createCaller`. The git procs
 *     are thin wrappers over already-tested ops; here we run them end-to-end over
 *     REAL git repos to lock the channel→proc + input-shape contract.
 *
 * Ordering matters: the top-level `test()` calls run SEQUENTIALLY in file order
 * and SHARE the git repo state built up across them (branches, commits, merges).
 * Do NOT reorder. Do NOT call h.cleanup() — it would close the DB before the
 * deferred async tests run.
 */
import { createTestHarness, test, expect, describe } from '../../../../test-utils/ipc-harness.js'
import { worktreesRouter } from './worktrees.js'
import {
  getGitWatcher,
  createWorktree,
  runWorktreeSetupScriptSync,
  initSubmodulesSync,
  resolveSubmoduleInitBehavior,
  getIgnoredFileTree,
  copyIgnoredFiles
} from '@slayzone/worktrees/server'
import { _mock } from '../../../../test-utils/mock-merge-ai.js'
import { execSync } from 'child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── Async-rejection helper (toThrow() is sync-only) ──────────────────────────
const didThrow = async (fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Watcher subscriptions — stub ctx is enough (they never touch ctx.db).
// ═══════════════════════════════════════════════════════════════════════════
const stubCtx = { db: {} as never, dataRoot: '' }

await describe('worktrees watcher subscriptions', () => {
  test('onDiffChanged forwards each emit, stops after unsubscribe', async () => {
    const watcher = getGitWatcher()
    const caller = worktreesRouter.createCaller(stubCtx)
    const obs = await caller.onDiffChanged()
    const got: string[] = []
    const sub = obs.subscribe({ next: (v: { worktreePath: string }) => got.push(v.worktreePath) })

    watcher.emit('git:diff-changed', { worktreePath: '/tmp/wt-a' })
    watcher.emit('git:diff-changed', { worktreePath: '/tmp/wt-b' })
    sub.unsubscribe()
    watcher.emit('git:diff-changed', { worktreePath: '/tmp/wt-after-unsub' })

    expect(got).toEqual(['/tmp/wt-a', '/tmp/wt-b'])
  })

  test('onDiffWatchFailed forwards each emit', async () => {
    const watcher = getGitWatcher()
    const caller = worktreesRouter.createCaller(stubCtx)
    const obs = await caller.onDiffWatchFailed()
    const got: string[] = []
    const sub = obs.subscribe({ next: (v: { worktreePath: string }) => got.push(v.worktreePath) })

    watcher.emit('git:diff-watch-failed', { worktreePath: '/tmp/wt-x' })
    sub.unsubscribe()

    expect(got).toEqual(['/tmp/wt-x'])
  })

  test('teardown removes the listener (no leak)', async () => {
    const watcher = getGitWatcher()
    const before = watcher.listenerCount('git:diff-changed')
    const caller = worktreesRouter.createCaller(stubCtx)
    const obs = await caller.onDiffChanged()
    const sub = obs.subscribe({ next: () => {} })
    expect(watcher.listenerCount('git:diff-changed')).toBe(before + 1)
    sub.unsubscribe()
    expect(watcher.listenerCount('git:diff-changed')).toBe(before)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Req/res procs over real git repos. One caller, shared db + shared repo.
// ═══════════════════════════════════════════════════════════════════════════
const h = await createTestHarness()
const caller = worktreesRouter.createCaller({ db: h.slayDb, dataRoot: '' } as never)

const root = h.tmpDir()
const repoPath = path.join(root, 'repo')
fs.mkdirSync(repoPath)

// Run git commands in the repo with deterministic author/committer identity.
function git(cmd: string, cwd = repoPath): string {
  return execSync(cmd, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com'
    }
  }).trim()
}

// --- init ---

await caller.init({ path: repoPath })

await describe('init', () => {
  test('repo was initialized', () => {
    expect(fs.existsSync(path.join(repoPath, '.git'))).toBe(true)
  })
})

// Create initial commit so HEAD exists
fs.writeFileSync(path.join(repoPath, 'README.md'), '# Test')
git('git add -A')
git('git commit -m "initial"')

// --- isGitRepo ---

await describe('isGitRepo', () => {
  test('returns true for git repo', async () => {
    expect(await caller.isGitRepo({ path: repoPath })).toBe(true)
  })

  test('returns false for non-repo', async () => {
    const noRepo = path.join(root, 'not-a-repo')
    fs.mkdirSync(noRepo)
    expect(await caller.isGitRepo({ path: noRepo })).toBe(false)
  })
})

// --- getCurrentBranch ---

await describe('getCurrentBranch', () => {
  test('returns current branch name', async () => {
    const branch = await caller.getCurrentBranch({ path: repoPath })
    expect(branch).toBeTruthy()
  })
})

// --- hasUncommittedChanges ---

await describe('hasUncommittedChanges', () => {
  test('returns false when clean', async () => {
    expect(await caller.hasUncommittedChanges({ path: repoPath })).toBe(false)
  })

  test('returns true when tracked file modified', async () => {
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Modified')
    expect(await caller.hasUncommittedChanges({ path: repoPath })).toBe(true)
    git('git checkout -- README.md') // restore
  })
})

// --- detectWorktrees ---

await describe('detectWorktrees', () => {
  test('detects main worktree', async () => {
    const worktrees = (await caller.detectWorktrees({ repoPath })) as {
      path: string
      branch: string | null
      isMain: boolean
    }[]
    expect(worktrees.length).toBeGreaterThan(0)
    const main = worktrees.find((w) => w.isMain)
    expect(main).toBeTruthy()
  })
})

// --- createWorktree (direct op) + removeWorktree (proc) ---

await describe('createWorktree', () => {
  test('creates worktree with new branch', async () => {
    const wtPath = path.join(root, 'wt-1')
    await createWorktree(repoPath, wtPath, 'feature-1')
    expect(fs.existsSync(wtPath)).toBe(true)
    const branch = git('git branch --show-current', wtPath)
    expect(branch).toBe('feature-1')
  })

  test('creates worktree from sourceBranch', async () => {
    git('git checkout -b release-1')
    fs.writeFileSync(path.join(repoPath, 'release.txt'), 'release content')
    git('git add release.txt')
    git('git commit -m "release file"')
    git('git checkout main')

    const wtPath = path.join(root, 'wt-source')
    await createWorktree(repoPath, wtPath, 'feature-from-release', 'release-1')
    expect(fs.existsSync(wtPath)).toBe(true)
    expect(fs.existsSync(path.join(wtPath, 'release.txt'))).toBe(true)
    // Clean up
    await caller.removeWorktree({ repoPath, worktreePath: wtPath })
  })
})

// --- .slay/worktree-setup.sh (direct op runWorktreeSetupScriptSync) ---

await describe('worktree setup script', () => {
  test('runs .slay/worktree-setup.sh with env vars', async () => {
    fs.mkdirSync(path.join(repoPath, '.slay'), { recursive: true })
    fs.writeFileSync(
      path.join(repoPath, '.slay', 'worktree-setup.sh'),
      '#!/bin/sh\necho "WORKTREE=$WORKTREE_PATH" > "$WORKTREE_PATH/.setup-ran"\necho "REPO=$REPO_PATH" >> "$WORKTREE_PATH/.setup-ran"\n',
      { mode: 0o755 }
    )
    git('git add .slay/worktree-setup.sh')
    git('git commit -m "add setup script"')

    const wtPath = path.join(root, 'wt-setup')
    await createWorktree(repoPath, wtPath, 'feature-setup')
    const result = runWorktreeSetupScriptSync(wtPath, repoPath)
    expect(result.ran).toBe(true)
    expect(result.success).toBe(true)
    const marker = fs.readFileSync(path.join(wtPath, '.setup-ran'), 'utf-8')
    expect(marker.includes(`WORKTREE=${wtPath}`)).toBe(true)
    expect(marker.includes(`REPO=${repoPath}`)).toBe(true)
    // Clean up
    await caller.removeWorktree({ repoPath, worktreePath: wtPath })
  })

  test('returns ran=false when no setup script', async () => {
    fs.unlinkSync(path.join(repoPath, '.slay', 'worktree-setup.sh'))
    fs.rmdirSync(path.join(repoPath, '.slay'))
    git('git add -A')
    git('git commit -m "remove setup script"')

    const wtPath = path.join(root, 'wt-no-setup')
    await createWorktree(repoPath, wtPath, 'feature-no-setup')
    const result = runWorktreeSetupScriptSync(wtPath, repoPath)
    expect(result.ran).toBe(false)
    // Clean up
    await caller.removeWorktree({ repoPath, worktreePath: wtPath })
  })
})

await describe('removeWorktree', () => {
  test('removes worktree', async () => {
    const wtPath = path.join(root, 'wt-1')
    await caller.removeWorktree({ repoPath, worktreePath: wtPath })
    expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(false)
  })
})

// --- resolveSubmoduleInitBehavior (direct op — no router proc) ---
// Op is async over SlayzoneDb, so drive it with h.slayDb (NOT raw h.db).

await describe('resolveSubmoduleInitBehavior', () => {
  test('defaults to auto when nothing set', async () => {
    expect(await resolveSubmoduleInitBehavior(h.slayDb)).toBe('auto')
  })

  test('uses global setting when project has no override', async () => {
    h.db
      .prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('worktree_submodule_init', 'skip')"
      )
      .run()
    expect(await resolveSubmoduleInitBehavior(h.slayDb)).toBe('skip')
    h.db.prepare("DELETE FROM settings WHERE key = 'worktree_submodule_init'").run()
  })

  test('project override beats global', async () => {
    h.db
      .prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('worktree_submodule_init', 'skip')"
      )
      .run()
    const pid = 'proj-submod-test'
    h.db
      .prepare(
        "INSERT INTO projects (id, name, color, sort_order, created_at, updated_at, worktree_submodule_init) VALUES (?, 'test', '#fff', 0, datetime('now'), datetime('now'), 'auto')"
      )
      .run(pid)
    expect(await resolveSubmoduleInitBehavior(h.slayDb, pid)).toBe('auto')
    h.db.prepare('DELETE FROM projects WHERE id = ?').run(pid)
    h.db.prepare("DELETE FROM settings WHERE key = 'worktree_submodule_init'").run()
  })
})

// --- initSubmodules (direct op initSubmodulesSync) ---

await describe('initSubmodules', () => {
  test('returns no-gitmodules when .gitmodules absent', () => {
    const wtPath = path.join(root, 'wt-nosubmod')
    fs.mkdirSync(wtPath)
    const result = initSubmodulesSync(wtPath)
    expect(result.ran).toBe(false)
    expect(result.reason).toBe('no-gitmodules')
  })

  test('initializes submodule when .gitmodules present', async () => {
    // Post-CVE-2022-39253: file:// submodules denied by default. Allow for all
    // subsequent git invocations (including the spawn inside initSubmodulesSync).
    process.env.GIT_CONFIG_PARAMETERS = "'protocol.file.allow=always'"

    const subSrc = path.join(root, 'sub-src')
    fs.mkdirSync(subSrc)
    git('git init -b main', subSrc)
    fs.writeFileSync(path.join(subSrc, 'lib.txt'), 'submodule lib')
    git('git add -A', subSrc)
    git('git commit -m "sub init"', subSrc)

    git(`git submodule add ${subSrc} vendor/foo`)
    git('git commit -m "add submodule"')

    const wtPath = path.join(root, 'wt-submod')
    await createWorktree(repoPath, wtPath, 'feature-submod')
    expect(fs.existsSync(path.join(wtPath, '.gitmodules'))).toBe(true)
    expect(fs.readdirSync(path.join(wtPath, 'vendor', 'foo')).length).toBe(0)

    const result = initSubmodulesSync(wtPath)
    expect(result.ran).toBe(true)
    expect(result.success).toBe(true)
    expect(fs.existsSync(path.join(wtPath, 'vendor', 'foo', 'lib.txt'))).toBe(true)

    await caller.removeWorktree({ repoPath, worktreePath: wtPath })
    delete process.env.GIT_CONFIG_PARAMETERS
  })
})

// --- Staging operations ---

// Create a feature branch for staging tests
git('git checkout -b staging-test')
fs.writeFileSync(path.join(repoPath, 'staged.txt'), 'staged content')
fs.writeFileSync(path.join(repoPath, 'unstaged.txt'), 'unstaged content')

await describe('stageFile', () => {
  test('stages a file', async () => {
    await caller.stageFile({ path: repoPath, filePath: 'staged.txt' })
    const status = git('git status --porcelain')
    expect(status.includes('A  staged.txt')).toBe(true)
  })
})

await describe('unstageFile', () => {
  test('unstages a file', async () => {
    await caller.unstageFile({ path: repoPath, filePath: 'staged.txt' })
    const status = git('git status --porcelain')
    expect(status.includes('?? staged.txt')).toBe(true)
  })
})

await describe('stageAll', () => {
  test('stages all files', async () => {
    await caller.stageAll({ path: repoPath })
    const status = git('git status --porcelain')
    // Both files staged
    expect(status.includes('A  staged.txt')).toBe(true)
    expect(status.includes('A  unstaged.txt')).toBe(true)
  })
})

await describe('unstageAll', () => {
  test('unstages all files', async () => {
    await caller.unstageAll({ path: repoPath })
    const status = git('git status --porcelain')
    expect(status.includes('?? staged.txt')).toBe(true)
  })
})

await describe('discardFile', () => {
  test('discards changes to tracked file', async () => {
    // Stage + commit a file first, then modify it
    git('git add staged.txt unstaged.txt')
    git('git commit -m "add files"')
    fs.writeFileSync(path.join(repoPath, 'staged.txt'), 'MODIFIED')
    await caller.discardFile({ path: repoPath, filePath: 'staged.txt' })
    const content = fs.readFileSync(path.join(repoPath, 'staged.txt'), 'utf-8')
    expect(content).toBe('staged content')
  })
})

// --- Diff operations ---

await describe('getWorkingDiff', () => {
  test('returns diff snapshot', async () => {
    // Make a change
    fs.writeFileSync(path.join(repoPath, 'staged.txt'), 'diff test')
    const diff = (await caller.getWorkingDiff({ path: repoPath })) as {
      targetPath: string
      files: string[]
      stagedFiles: string[]
      unstagedFiles: string[]
      untrackedFiles: string[]
      isGitRepo: boolean
    }
    expect(diff.isGitRepo).toBe(true)
    expect(diff.files.length).toBeGreaterThan(0)
    expect(diff.unstagedFiles).toContain('staged.txt')
    // Restore
    git('git checkout -- staged.txt')
  })

  test('lists untracked files with unicode names', async () => {
    const name = 'ändringar.txt'
    fs.writeFileSync(path.join(repoPath, name), 'swedish chars')
    const diff = (await caller.getWorkingDiff({ path: repoPath })) as {
      untrackedFiles: string[]
      files: string[]
    }
    expect(diff.untrackedFiles).toContain(name)
    expect(diff.files).toContain(name)
    fs.unlinkSync(path.join(repoPath, name))
  })
})

await describe('getUntrackedFileDiff', () => {
  test('returns diff for untracked file', async () => {
    fs.writeFileSync(path.join(repoPath, 'new-untracked.txt'), 'hello')
    const diff = (await caller.getUntrackedFileDiff({
      repoPath,
      filePath: 'new-untracked.txt'
    })) as string
    expect(diff.includes('hello')).toBe(true)
    fs.unlinkSync(path.join(repoPath, 'new-untracked.txt'))
  })

  // CONTRACT DIVERGENCE: the handler accepted `null` filePath (op's `if (!filePath)
  // return ''` guard). The router's zod input is `filePath: z.string()` — non-nullable
  // — so a literal `null` is rejected before the op runs. We exercise the op's
  // falsy-guard with the narrowest zod-valid falsy value (empty string), which the
  // op treats identically (returns '').
  test('returns empty string for empty filePath (op falsy-guard via narrowest valid input)', async () => {
    const diff = (await caller.getUntrackedFileDiff({ repoPath, filePath: '' })) as string
    expect(diff).toBe('')
  })

  // And document the divergence directly: null is now a validation error.
  test('rejects null filePath (zod stricter than legacy handler)', async () => {
    expect(
      await didThrow(() =>
        caller.getUntrackedFileDiff({ repoPath, filePath: null as unknown as string })
      )
    ).toBe(true)
  })

  test('returns diff for file with unicode name', async () => {
    const name = 'protokoll från möte.txt'
    fs.writeFileSync(path.join(repoPath, name), 'unicode content')
    const diff = (await caller.getUntrackedFileDiff({ repoPath, filePath: name })) as string
    expect(diff.includes('unicode content')).toBe(true)
    fs.unlinkSync(path.join(repoPath, name))
  })
})

// --- Commit ---

await describe('commitFiles', () => {
  test('creates a commit', async () => {
    fs.writeFileSync(path.join(repoPath, 'commit-test.txt'), 'commit me')
    git('git add commit-test.txt')
    await caller.commitFiles({ repoPath, message: 'test commit message' })
    const log = git('git log --oneline -1')
    expect(log.includes('test commit message')).toBe(true)
  })
})

// --- Merge operations ---

await describe('isMergeInProgress', () => {
  test('returns false when no merge', async () => {
    expect(await caller.isMergeInProgress({ path: repoPath })).toBe(false)
  })
})

// Set up branches for merge test
const mainBranch = git('git branch --show-current')
git('git checkout -b merge-source')
fs.writeFileSync(path.join(repoPath, 'merge-file.txt'), 'source content')
git('git add merge-file.txt')
git('git commit -m "source branch commit"')
git(`git checkout ${mainBranch}`)

await describe('mergeIntoParent', () => {
  test('merges clean branch', async () => {
    const result = (await caller.mergeIntoParent({
      projectPath: repoPath,
      parentBranch: mainBranch,
      sourceBranch: 'merge-source'
    })) as {
      success: boolean
      merged: boolean
      conflicted: boolean
    }
    expect(result.success).toBe(true)
    expect(result.merged).toBe(true)
    expect(result.conflicted).toBe(false)
    // File should exist after merge
    expect(fs.existsSync(path.join(repoPath, 'merge-file.txt'))).toBe(true)
  })
})

// Set up conflict scenario
git('git checkout -b conflict-a')
fs.writeFileSync(path.join(repoPath, 'conflict.txt'), 'version A')
git('git add conflict.txt')
git('git commit -m "conflict A"')
git(`git checkout ${mainBranch}`)
git('git checkout -b conflict-b')
fs.writeFileSync(path.join(repoPath, 'conflict.txt'), 'version B')
git('git add conflict.txt')
git('git commit -m "conflict B"')
git('git checkout conflict-a')

await describe('mergeIntoParent (conflict)', () => {
  test('detects merge conflicts', async () => {
    const result = (await caller.mergeIntoParent({
      projectPath: repoPath,
      parentBranch: 'conflict-a',
      sourceBranch: 'conflict-b'
    })) as {
      success: boolean
      conflicted: boolean
      error?: string
    }
    expect(result.conflicted).toBe(true)
    expect(result.success).toBe(false)
  })
})

await describe('getConflictedFiles', () => {
  test('lists conflicted files', async () => {
    const files = (await caller.getConflictedFiles({ path: repoPath })) as string[]
    expect(files).toContain('conflict.txt')
  })
})

await describe('getConflictContent', () => {
  test('returns base/ours/theirs/merged', async () => {
    const content = (await caller.getConflictContent({
      repoPath,
      filePath: 'conflict.txt'
    })) as {
      path: string
      base: string | null
      ours: string | null
      theirs: string | null
      merged: string | null
    }
    expect(content.path).toBe('conflict.txt')
    expect(content.ours).toBeTruthy()
    expect(content.theirs).toBeTruthy()
    expect(content.merged).toBeTruthy() // Contains conflict markers
  })
})

await describe('writeResolvedFile', () => {
  test('writes resolved content', async () => {
    await caller.writeResolvedFile({
      repoPath,
      filePath: 'conflict.txt',
      content: 'resolved content'
    })
    const content = fs.readFileSync(path.join(repoPath, 'conflict.txt'), 'utf-8')
    expect(content).toBe('resolved content')
  })
})

await describe('abortMerge', () => {
  test('aborts merge in progress', async () => {
    await caller.abortMerge({ path: repoPath })
    expect(await caller.isMergeInProgress({ path: repoPath })).toBe(false)
  })
})

// --- mergeWithAI (logic only, no AI call) ---

await describe('mergeWithAI', () => {
  test('returns success on clean merge', async () => {
    // Create a branch that merges cleanly
    git(`git checkout ${mainBranch}`)
    git('git checkout -b clean-merge-src')
    fs.writeFileSync(path.join(repoPath, 'clean-merge.txt'), 'clean')
    git('git add clean-merge.txt')
    git('git commit -m "clean merge source"')
    git(`git checkout ${mainBranch}`)

    const result = (await caller.mergeWithAI({
      projectPath: repoPath,
      worktreePath: repoPath,
      parentBranch: mainBranch,
      sourceBranch: 'clean-merge-src'
    })) as {
      success?: boolean
      resolving?: boolean
    }
    expect(result.success).toBe(true)
  })

  test('returns resolving with prompt on conflict', async () => {
    // Set up conflicting branches
    git('git checkout -b ai-base')
    fs.writeFileSync(path.join(repoPath, 'ai-conflict.txt'), 'ai base')
    git('git add ai-conflict.txt')
    git('git commit -m "ai base"')
    git('git checkout -b ai-other')
    fs.writeFileSync(path.join(repoPath, 'ai-conflict.txt'), 'ai other')
    git('git add ai-conflict.txt')
    git('git commit -m "ai other"')
    git('git checkout ai-base')
    fs.writeFileSync(path.join(repoPath, 'ai-conflict.txt'), 'ai mine')
    git('git add ai-conflict.txt')
    git('git commit -m "ai mine"')

    const result = (await caller.mergeWithAI({
      projectPath: repoPath,
      worktreePath: repoPath,
      parentBranch: 'ai-base',
      sourceBranch: 'ai-other'
    })) as {
      resolving?: boolean
      prompt?: string
      conflictedFiles?: string[]
    }
    expect(result.resolving).toBe(true)
    expect(result.prompt).toBeTruthy()
    expect(result.conflictedFiles).toContain('ai-conflict.txt')

    // Clean up merge state
    git('git merge --abort')
  })
})

// --- getWorkingDiff with fromSha/toSha (Turns range mode) ---

await describe('getWorkingDiff range mode', () => {
  test('diff between two arbitrary SHAs returns scoped patch + file list', async () => {
    const sha1 = git('git rev-parse HEAD')
    fs.writeFileSync(path.join(repoPath, 'range-a.txt'), 'first turn change')
    git('git add range-a.txt')
    git('git commit -m "range turn a"')
    const sha2 = git('git rev-parse HEAD')

    const snap = (await caller.getWorkingDiff({
      path: repoPath,
      opts: { contextLines: 'all', fromSha: sha1, toSha: sha2 }
    })) as {
      files: string[]
      unstagedPatch: string
      stagedPatch: string
      stagedFiles: string[]
      untrackedFiles: string[]
    }

    expect(snap.files).toContain('range-a.txt')
    expect(snap.unstagedPatch.includes('first turn change')).toBe(true)
    // Range mode collapses everything into unstaged side
    expect(snap.stagedPatch).toBe('')
    expect(snap.stagedFiles).toHaveLength(0)
    expect(snap.untrackedFiles).toHaveLength(0)
  })

  test('diff between identical SHAs returns empty', async () => {
    const sha = git('git rev-parse HEAD')
    const snap = (await caller.getWorkingDiff({
      path: repoPath,
      opts: { fromSha: sha, toSha: sha }
    })) as { files: string[]; unstagedPatch: string }
    expect(snap.files).toHaveLength(0)
    expect(snap.unstagedPatch).toBe('')
  })

  test('without fromSha/toSha falls back to HEAD-based working diff', async () => {
    fs.writeFileSync(path.join(repoPath, 'unstaged-edit.txt'), 'live change')
    const snap = (await caller.getWorkingDiff({
      path: repoPath,
      opts: { contextLines: 'all' }
    })) as { untrackedFiles: string[] }
    // Untracked file appears (unique to non-range mode)
    expect(snap.untrackedFiles.includes('unstaged-edit.txt')).toBe(true)
    fs.unlinkSync(path.join(repoPath, 'unstaged-edit.txt'))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// analyzeConflict — ports the cross-domain integrations/handlers.analyze tests.
// The loader redirects ./merge-ai → mock-merge-ai.ts, so the router's
// analyzeConflict picks up `_mock` automatically. Drive return values via _mock.
// ═══════════════════════════════════════════════════════════════════════════

await describe('analyzeConflict', () => {
  test('parses SUMMARY + ---RESOLUTION--- correctly', async () => {
    _mock.runAiCommand = async () =>
      'SUMMARY: Branch A added a header, branch B changed the footer. They conflict in the middle section.\n---RESOLUTION---\nresolved line 1\nresolved line 2'

    const result = (await caller.analyzeConflict({
      mode: 'claude-code',
      filePath: 'file.ts',
      base: 'base content',
      ours: 'ours content',
      theirs: 'theirs content'
    })) as { summary: string; suggestion: string }
    expect(result.summary).toBe(
      'Branch A added a header, branch B changed the footer. They conflict in the middle section.'
    )
    expect(result.suggestion).toBe('resolved line 1\nresolved line 2')
  })

  test('handles missing separator — returns raw as summary', async () => {
    _mock.runAiCommand = async () => 'Just a plain response without separator'

    const result = (await caller.analyzeConflict({
      mode: 'claude-code',
      filePath: 'file.ts',
      base: 'base',
      ours: 'ours',
      theirs: 'theirs'
    })) as { summary: string; suggestion: string }
    expect(result.summary).toBe('Just a plain response without separator')
    expect(result.suggestion).toBe('')
  })

  test('handles empty AI response', async () => {
    _mock.runAiCommand = async () => ''

    const result = (await caller.analyzeConflict({
      mode: 'codex',
      filePath: 'file.ts',
      base: null,
      ours: 'ours',
      theirs: 'theirs'
    })) as { summary: string; suggestion: string }
    expect(result.summary).toBe('')
    expect(result.suggestion).toBe('')
  })

  test('strips SUMMARY: prefix from output', async () => {
    _mock.runAiCommand = async () => 'SUMMARY: conflict explanation\n---RESOLUTION---\nfixed'

    const result = (await caller.analyzeConflict({
      mode: 'claude-code',
      filePath: 'f.ts',
      base: null,
      ours: null,
      theirs: null
    })) as { summary: string; suggestion: string }
    expect(result.summary).toBe('conflict explanation')
    expect(result.suggestion).toBe('fixed')
  })

  test('propagates AI error', async () => {
    _mock.runAiCommand = async () => {
      throw new Error('Timeout')
    }

    expect(
      await didThrow(() =>
        caller.analyzeConflict({
          mode: 'claude-code',
          filePath: 'f.ts',
          base: 'b',
          ours: 'o',
          theirs: 't'
        })
      )
    ).toBe(true)
  })

  test('handles multiline resolution with code', async () => {
    const resolution = '```ts\nfunction merge() {\n  return "both";\n}\n```'
    _mock.runAiCommand = async () =>
      `SUMMARY: Both branches modified the merge function.\n---RESOLUTION---\n${resolution}`

    const result = (await caller.analyzeConflict({
      mode: 'claude-code',
      filePath: 'merge.ts',
      base: 'old',
      ours: 'ours',
      theirs: 'theirs'
    })) as { summary: string; suggestion: string }
    expect(result.summary).toBe('Both branches modified the merge function.')
    expect(result.suggestion).toBe(resolution)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// copy-files — getIgnoredFileTree / copyIgnoredFiles (direct ops) +
// resolveCopyBehavior (router proc). Uses a SEPARATE repo to avoid disturbing
// the shared `repoPath` git state above.
// ═══════════════════════════════════════════════════════════════════════════

const cfRoot = h.tmpDir()
const cfRepo = path.join(cfRoot, 'repo')
fs.mkdirSync(cfRepo)

function cfGit(cmd: string, cwd = cfRepo): string {
  return execSync(cmd, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com'
    }
  }).trim()
}

// Setup: repo with ignored dist/, build/, *.log
cfGit('git init')
fs.writeFileSync(path.join(cfRepo, 'README.md'), '# Test')
fs.writeFileSync(path.join(cfRepo, '.gitignore'), 'dist/\n*.log\nbuild/\n')
cfGit('git add -A')
cfGit('git commit -m "initial"')

fs.mkdirSync(path.join(cfRepo, 'dist'), { recursive: true })
fs.writeFileSync(path.join(cfRepo, 'dist', 'bundle.js'), 'console.log("hi")')
fs.writeFileSync(path.join(cfRepo, 'dist', 'index.css'), 'body{}')
fs.mkdirSync(path.join(cfRepo, 'dist', 'nested'), { recursive: true })
fs.writeFileSync(path.join(cfRepo, 'dist', 'nested', 'deep.js'), 'deep')
fs.writeFileSync(path.join(cfRepo, 'app.log'), 'log line')
fs.mkdirSync(path.join(cfRepo, 'build'), { recursive: true })
fs.writeFileSync(path.join(cfRepo, 'build', 'output.js'), 'output')

await describe('getIgnoredFileTree', () => {
  test('returns top-level nodes', async () => {
    const tree = await getIgnoredFileTree(cfRepo)
    expect(tree.length).toBe(3) // build/, dist/, app.log
    const names = tree.map((n) => n.name)
    expect(names).toContain('app.log')
    expect(names).toContain('dist')
    expect(names).toContain('build')
  })

  test('dirs sorted before files', async () => {
    const tree = await getIgnoredFileTree(cfRepo)
    expect(tree[0].isDirectory).toBe(true)
    expect(tree[1].isDirectory).toBe(true)
    expect(tree[2].isDirectory).toBe(false)
  })

  test('directory nodes have correct fileCount and children', async () => {
    const tree = await getIgnoredFileTree(cfRepo)
    const dist = tree.find((n) => n.name === 'dist')!
    expect(dist.isDirectory).toBe(true)
    expect(dist.fileCount).toBe(3) // bundle.js, index.css, nested/deep.js
    expect(dist.children.length).toBe(3) // bundle.js, index.css, nested/
  })

  test('nested directory has children', async () => {
    const tree = await getIgnoredFileTree(cfRepo)
    const dist = tree.find((n) => n.name === 'dist')!
    const nested = dist.children.find((c) => c.name === 'nested')!
    expect(nested.isDirectory).toBe(true)
    expect(nested.fileCount).toBe(1)
    expect(nested.children.length).toBe(1)
    expect(nested.children[0].name).toBe('deep.js')
    expect(nested.children[0].isDirectory).toBe(false)
  })

  test('top-level file has real size', async () => {
    const tree = await getIgnoredFileTree(cfRepo)
    const logFile = tree.find((n) => n.name === 'app.log')!
    expect(logFile.size).toBeGreaterThan(0)
  })

  test('directory nodes have size 0', async () => {
    const tree = await getIgnoredFileTree(cfRepo)
    const dist = tree.find((n) => n.name === 'dist')!
    expect(dist.size).toBe(0)
  })

  test('file node has correct path', async () => {
    const tree = await getIgnoredFileTree(cfRepo)
    const dist = tree.find((n) => n.name === 'dist')!
    const bundle = dist.children.find((c) => c.name === 'bundle.js')!
    expect(bundle.path).toBe('dist/bundle.js')
  })

  test('returns empty for repo with no ignored files', async () => {
    const cleanRepo = path.join(cfRoot, 'clean-repo')
    fs.mkdirSync(cleanRepo)
    cfGit('git init', cleanRepo)
    fs.writeFileSync(path.join(cleanRepo, 'hello.txt'), 'hi')
    cfGit('git add -A', cleanRepo)
    cfGit('git commit -m "init"', cleanRepo)

    const tree = await getIgnoredFileTree(cleanRepo)
    expect(tree.length).toBe(0)
  })
})

await describe('copyIgnoredFiles', () => {
  test('copies selected directory to worktree', async () => {
    const wtPath = path.join(cfRoot, 'wt-copy-1')
    await createWorktree(cfRepo, wtPath, 'copy-test-1')

    await copyIgnoredFiles(cfRepo, wtPath, 'custom', ['dist'])
    expect(fs.existsSync(path.join(wtPath, 'dist', 'bundle.js'))).toBe(true)
    expect(fs.existsSync(path.join(wtPath, 'dist', 'nested', 'deep.js'))).toBe(true)
    expect(fs.existsSync(path.join(wtPath, 'app.log'))).toBe(false)

    cfGit(`git worktree remove "${wtPath}" --force`)
  })

  test('copies individual files', async () => {
    const wtPath = path.join(cfRoot, 'wt-copy-2')
    await createWorktree(cfRepo, wtPath, 'copy-test-2')

    await copyIgnoredFiles(cfRepo, wtPath, 'custom', ['app.log'])
    expect(fs.existsSync(path.join(wtPath, 'app.log'))).toBe(true)
    expect(fs.existsSync(path.join(wtPath, 'dist'))).toBe(false)

    cfGit(`git worktree remove "${wtPath}" --force`)
  })

  test('copies all with behavior=all', async () => {
    const wtPath = path.join(cfRoot, 'wt-copy-3')
    await createWorktree(cfRepo, wtPath, 'copy-test-3')

    await copyIgnoredFiles(cfRepo, wtPath, 'all', [])
    expect(fs.existsSync(path.join(wtPath, 'dist', 'bundle.js'))).toBe(true)
    expect(fs.existsSync(path.join(wtPath, 'app.log'))).toBe(true)
    expect(fs.existsSync(path.join(wtPath, 'build', 'output.js'))).toBe(true)

    cfGit(`git worktree remove "${wtPath}" --force`)
  })

  test('skips path traversal attempts', async () => {
    const wtPath = path.join(cfRoot, 'wt-copy-4')
    await createWorktree(cfRepo, wtPath, 'copy-test-4')

    await copyIgnoredFiles(cfRepo, wtPath, 'custom', ['../etc/passwd'])
    expect(fs.existsSync(path.join(wtPath, '..', 'etc'))).toBe(false)

    cfGit(`git worktree remove "${wtPath}" --force`)
  })

  test('copied content bytes match source', async () => {
    const wtPath = path.join(cfRoot, 'wt-copy-bytes')
    await createWorktree(cfRepo, wtPath, 'copy-test-bytes')

    await copyIgnoredFiles(cfRepo, wtPath, 'custom', ['dist', 'app.log'])
    const srcBundle = fs.readFileSync(path.join(cfRepo, 'dist', 'bundle.js'))
    const dstBundle = fs.readFileSync(path.join(wtPath, 'dist', 'bundle.js'))
    expect(srcBundle.equals(dstBundle)).toBe(true)
    const srcLog = fs.readFileSync(path.join(cfRepo, 'app.log'))
    const dstLog = fs.readFileSync(path.join(wtPath, 'app.log'))
    expect(srcLog.equals(dstLog)).toBe(true)

    cfGit(`git worktree remove "${wtPath}" --force`)
  })

  test('does not nest when top-level dir is tracked but has ignored children', async () => {
    // Repro: main repo has tracked `src/` with ignored child `src/build/out.js`.
    // Worktree-creation copy must NOT result in nested `wt/src/src/...`.
    const partialRepo = path.join(cfRoot, 'partial-tracked-repo')
    fs.mkdirSync(partialRepo)
    cfGit('git init', partialRepo)
    fs.writeFileSync(path.join(partialRepo, '.gitignore'), 'build/\nsettings.local.json\n')
    fs.mkdirSync(path.join(partialRepo, 'src'), { recursive: true })
    fs.writeFileSync(path.join(partialRepo, 'src', 'index.js'), 'tracked from main')
    fs.mkdirSync(path.join(partialRepo, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(partialRepo, '.claude', 'agents.md'), 'tracked agents')
    cfGit('git add -A', partialRepo)
    cfGit('git commit -m "init"', partialRepo)

    // Ignored children under tracked dirs
    fs.mkdirSync(path.join(partialRepo, 'src', 'build'), { recursive: true })
    fs.writeFileSync(path.join(partialRepo, 'src', 'build', 'out.js'), 'ignored output')
    fs.writeFileSync(path.join(partialRepo, '.claude', 'settings.local.json'), '{"local":true}')

    const wtPath = path.join(cfRoot, 'wt-partial-tracked')
    await createWorktree(partialRepo, wtPath, 'partial-tracked-test')

    // Sanity: worktree has tracked content from initial commit
    expect(fs.existsSync(path.join(wtPath, 'src', 'index.js'))).toBe(true)
    expect(fs.existsSync(path.join(wtPath, '.claude', 'agents.md'))).toBe(true)

    await copyIgnoredFiles(partialRepo, wtPath, 'all', [])

    // Ignored children must be copied to expected (non-nested) paths
    expect(fs.existsSync(path.join(wtPath, 'src', 'build', 'out.js'))).toBe(true)
    expect(fs.existsSync(path.join(wtPath, '.claude', 'settings.local.json'))).toBe(true)
    // No nesting allowed
    expect(fs.existsSync(path.join(wtPath, 'src', 'src'))).toBe(false)
    expect(fs.existsSync(path.join(wtPath, '.claude', '.claude'))).toBe(false)
    // Tracked content unmodified
    expect(fs.readFileSync(path.join(wtPath, 'src', 'index.js'), 'utf-8')).toBe('tracked from main')
    expect(fs.readFileSync(path.join(wtPath, '.claude', 'agents.md'), 'utf-8')).toBe('tracked agents')

    execSync(`git worktree remove "${wtPath}" --force`, { cwd: partialRepo })
  })

  test('custom path that names a tracked dir does not nest', async () => {
    const partialRepo = path.join(cfRoot, 'partial-custom-repo')
    fs.mkdirSync(partialRepo)
    cfGit('git init', partialRepo)
    fs.writeFileSync(path.join(partialRepo, '.gitignore'), 'cache/\n')
    fs.mkdirSync(path.join(partialRepo, 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(partialRepo, 'pkg', 'tracked.js'), 'tracked')
    cfGit('git add -A', partialRepo)
    cfGit('git commit -m "init"', partialRepo)
    fs.mkdirSync(path.join(partialRepo, 'pkg', 'cache'), { recursive: true })
    fs.writeFileSync(path.join(partialRepo, 'pkg', 'cache', 'blob.bin'), 'cached')

    const wtPath = path.join(cfRoot, 'wt-partial-custom')
    await createWorktree(partialRepo, wtPath, 'partial-custom-test')

    await copyIgnoredFiles(partialRepo, wtPath, 'custom', ['pkg'])

    expect(fs.existsSync(path.join(wtPath, 'pkg', 'cache', 'blob.bin'))).toBe(true)
    expect(fs.existsSync(path.join(wtPath, 'pkg', 'pkg'))).toBe(false)
    expect(fs.readFileSync(path.join(wtPath, 'pkg', 'tracked.js'), 'utf-8')).toBe('tracked')

    execSync(`git worktree remove "${wtPath}" --force`, { cwd: partialRepo })
  })

  test('preserves symlinks (pnpm node_modules pattern)', async () => {
    // Isolated repo so we don't pollute shared cfRepo state
    const symRepo = path.join(cfRoot, 'sym-repo')
    fs.mkdirSync(symRepo)
    cfGit('git init', symRepo)
    fs.writeFileSync(path.join(symRepo, 'README.md'), '# sym')
    fs.writeFileSync(path.join(symRepo, '.gitignore'), 'node_modules/\n')
    cfGit('git add -A', symRepo)
    cfGit('git commit -m "init"', symRepo)

    // Mimic pnpm: real file in .pnpm/, symlink in node_modules/
    fs.mkdirSync(path.join(symRepo, 'node_modules', '.pnpm', 'pkg@1.0.0'), { recursive: true })
    fs.writeFileSync(
      path.join(symRepo, 'node_modules', '.pnpm', 'pkg@1.0.0', 'index.js'),
      'module.exports = 1'
    )
    fs.symlinkSync('.pnpm/pkg@1.0.0', path.join(symRepo, 'node_modules', 'pkg'))

    const wtPath = path.join(cfRoot, 'wt-copy-symlink')
    await createWorktree(symRepo, wtPath, 'copy-test-symlink')

    await copyIgnoredFiles(symRepo, wtPath, 'custom', ['node_modules'])
    const linkPath = path.join(wtPath, 'node_modules', 'pkg')
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(linkPath)).toBe('.pnpm/pkg@1.0.0')

    execSync(`git worktree remove "${wtPath}" --force`, { cwd: symRepo })
  })
})

// --- resolveCopyBehavior (router proc — uses ctx.db = h.slayDb) ---

await describe('resolveCopyBehavior', () => {
  test('returns ask by default', async () => {
    const result = await caller.resolveCopyBehavior({})
    expect(result.behavior).toBe('ask')
    expect(result.customPaths).toEqual([])
  })

  test('returns global setting when set', async () => {
    h.db
      .prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('worktree_copy_behavior', 'all')"
      )
      .run()
    const result = await caller.resolveCopyBehavior({})
    expect(result.behavior).toBe('all')
    h.db.prepare("DELETE FROM settings WHERE key = 'worktree_copy_behavior'").run()
  })

  test('project override takes precedence', async () => {
    h.db
      .prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('worktree_copy_behavior', 'all')"
      )
      .run()
    const projectId = 'test-project-copy'
    h.db
      .prepare(
        'INSERT OR REPLACE INTO projects (id, name, path, color, worktree_copy_behavior) VALUES (?, ?, ?, ?, ?)'
      )
      .run(projectId, 'Test', cfRepo, '#000000', 'none')

    const result = await caller.resolveCopyBehavior({ projectId })
    expect(result.behavior).toBe('none')

    const global = await caller.resolveCopyBehavior({})
    expect(global.behavior).toBe('all')

    h.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
    h.db.prepare("DELETE FROM settings WHERE key = 'worktree_copy_behavior'").run()
  })

  test('returns custom paths for custom behavior', async () => {
    h.db
      .prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('worktree_copy_behavior', 'custom')"
      )
      .run()
    h.db
      .prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('worktree_copy_paths', 'node_modules, .env, dist')"
      )
      .run()

    const result = await caller.resolveCopyBehavior({})
    expect(result.behavior).toBe('custom')
    expect(result.customPaths).toEqual(['node_modules', '.env', 'dist'])

    h.db.prepare("DELETE FROM settings WHERE key LIKE 'worktree_copy%'").run()
  })
})

// --- getIgnoredFileTree + copyIgnoredFiles via router procs ---

await describe('getIgnoredFileTree / copyIgnoredFiles via router', () => {
  test('getIgnoredFileTree proc', async () => {
    const tree = (await caller.getIgnoredFileTree({ repoPath: cfRepo })) as {
      name: string
      children: unknown[]
    }[]
    expect(tree.length).toBe(3)
    const dist = tree.find((n) => n.name === 'dist')!
    expect(dist.children.length).toBe(3)
  })

  // Router proc defaults mode: paths.length>0 → 'custom' (matches legacy handler).
  test('copyIgnoredFiles proc (mode defaulted from paths)', async () => {
    const wtPath = path.join(cfRoot, 'wt-proc-copy')
    await createWorktree(cfRepo, wtPath, 'proc-copy-test')

    await caller.copyIgnoredFiles({ repoPath: cfRepo, worktreePath: wtPath, paths: ['dist', 'app.log'] })
    expect(fs.existsSync(path.join(wtPath, 'dist', 'bundle.js'))).toBe(true)
    expect(fs.existsSync(path.join(wtPath, 'app.log'))).toBe(true)

    cfGit(`git worktree remove "${wtPath}" --force`)
  })

  test('resolveCopyBehavior proc returns ask by default', async () => {
    const result = await caller.resolveCopyBehavior({})
    expect(result.behavior).toBe('ask')
  })
})

// NOTE: intentionally NO h.cleanup() — closing the DB here would break any
// still-deferred async test (sequential queue). The harness tmp dirs are
// OS-temp scratch; the process exits right after.
console.log('\nDone')
