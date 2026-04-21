/**
 * Git/worktree handler contract tests (uses real git repos in tmp dirs)
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/domains/worktrees/src/main/handlers.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { registerWorktreeHandlers } from './handlers.js'
import { createWorktree, runWorktreeSetupScriptSync, initSubmodulesSync } from './git-worktree.js'
import { resolveSubmoduleInitBehavior } from './handlers.js'
import { execSync } from 'child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const h = await createTestHarness()
registerWorktreeHandlers(h.ipcMain as never, h.db as never)

const root = h.tmpDir()
const repoPath = path.join(root, 'repo')
fs.mkdirSync(repoPath)

// Helper to run git commands in the repo
function git(cmd: string, cwd = repoPath) {
  return execSync(cmd, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.com' } }).trim()
}

// --- git:init ---

await h.invoke('git:init', repoPath)

await describe('git:init', () => {
  test('repo was initialized', () => {
    expect(fs.existsSync(path.join(repoPath, '.git'))).toBe(true)
  })
})

// Create initial commit so HEAD exists
fs.writeFileSync(path.join(repoPath, 'README.md'), '# Test')
git('git add -A')
git('git commit -m "initial"')

// --- git:isGitRepo ---

await describe('git:isGitRepo', () => {
  test('returns true for git repo', async () => {
    expect(await h.invoke('git:isGitRepo', repoPath)).toBe(true)
  })

  test('returns false for non-repo', async () => {
    const noRepo = path.join(root, 'not-a-repo')
    fs.mkdirSync(noRepo)
    expect(await h.invoke('git:isGitRepo', noRepo)).toBe(false)
  })
})

// --- git:getCurrentBranch ---

await describe('git:getCurrentBranch', () => {
  test('returns current branch name', async () => {
    const branch = await h.invoke('git:getCurrentBranch', repoPath)
    expect(branch).toBeTruthy()
  })
})

// --- git:hasUncommittedChanges ---

await describe('git:hasUncommittedChanges', () => {
  test('returns false when clean', async () => {
    expect(await h.invoke('git:hasUncommittedChanges', repoPath)).toBe(false)
  })

  test('returns true when tracked file modified', async () => {
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Modified')
    expect(await h.invoke('git:hasUncommittedChanges', repoPath)).toBe(true)
    git('git checkout -- README.md') // restore
  })
})

// --- git:detectWorktrees ---

await describe('git:detectWorktrees', () => {
  test('detects main worktree', async () => {
    const worktrees = await h.invoke('git:detectWorktrees', repoPath) as { path: string; branch: string | null; isMain: boolean }[]
    expect(worktrees.length).toBeGreaterThan(0)
    const main = worktrees.find(w => w.isMain)
    expect(main).toBeTruthy()
  })
})

// --- git:createWorktree + git:removeWorktree ---

await describe('git:createWorktree', () => {
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
    await h.invoke('git:removeWorktree', repoPath, wtPath)
  })
})

// --- .slay/worktree-setup.sh ---

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
    await h.invoke('git:removeWorktree', repoPath, wtPath)
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
    await h.invoke('git:removeWorktree', repoPath, wtPath)
  })
})

await describe('git:removeWorktree', () => {
  test('removes worktree', async () => {
    const wtPath = path.join(root, 'wt-1')
    await h.invoke('git:removeWorktree', repoPath, wtPath)
    expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(false)
  })
})

// --- Submodule init ---

await describe('resolveSubmoduleInitBehavior', () => {
  test('defaults to auto when nothing set', () => {
    expect(resolveSubmoduleInitBehavior(h.db as never)).toBe('auto')
  })

  test('uses global setting when project has no override', () => {
    h.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('worktree_submodule_init', 'skip')").run()
    expect(resolveSubmoduleInitBehavior(h.db as never)).toBe('skip')
    h.db.prepare("DELETE FROM settings WHERE key = 'worktree_submodule_init'").run()
  })

  test('project override beats global', () => {
    h.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('worktree_submodule_init', 'skip')").run()
    const pid = 'proj-submod-test'
    h.db.prepare("INSERT INTO projects (id, name, color, sort_order, created_at, updated_at, worktree_submodule_init) VALUES (?, 'test', '#fff', 0, datetime('now'), datetime('now'), 'auto')").run(pid)
    expect(resolveSubmoduleInitBehavior(h.db as never, pid)).toBe('auto')
    h.db.prepare('DELETE FROM projects WHERE id = ?').run(pid)
    h.db.prepare("DELETE FROM settings WHERE key = 'worktree_submodule_init'").run()
  })
})

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

    await h.invoke('git:removeWorktree', repoPath, wtPath)
    delete process.env.GIT_CONFIG_PARAMETERS
  })
})

// --- Staging operations ---

// Create a feature branch for staging tests
git('git checkout -b staging-test')
fs.writeFileSync(path.join(repoPath, 'staged.txt'), 'staged content')
fs.writeFileSync(path.join(repoPath, 'unstaged.txt'), 'unstaged content')

await describe('git:stageFile', () => {
  test('stages a file', async () => {
    await h.invoke('git:stageFile', repoPath, 'staged.txt')
    const status = git('git status --porcelain')
    expect(status.includes('A  staged.txt')).toBe(true)
  })
})

await describe('git:unstageFile', () => {
  test('unstages a file', async () => {
    await h.invoke('git:unstageFile', repoPath, 'staged.txt')
    const status = git('git status --porcelain')
    expect(status.includes('?? staged.txt')).toBe(true)
  })
})

await describe('git:stageAll', () => {
  test('stages all files', async () => {
    await h.invoke('git:stageAll', repoPath)
    const status = git('git status --porcelain')
    // Both files staged
    expect(status.includes('A  staged.txt')).toBe(true)
    expect(status.includes('A  unstaged.txt')).toBe(true)
  })
})

await describe('git:unstageAll', () => {
  test('unstages all files', async () => {
    await h.invoke('git:unstageAll', repoPath)
    const status = git('git status --porcelain')
    expect(status.includes('?? staged.txt')).toBe(true)
  })
})

await describe('git:discardFile', () => {
  test('discards changes to tracked file', async () => {
    // Stage + commit a file first, then modify it
    git('git add staged.txt unstaged.txt')
    git('git commit -m "add files"')
    fs.writeFileSync(path.join(repoPath, 'staged.txt'), 'MODIFIED')
    await h.invoke('git:discardFile', repoPath, 'staged.txt')
    const content = fs.readFileSync(path.join(repoPath, 'staged.txt'), 'utf-8')
    expect(content).toBe('staged content')
  })
})

// --- Diff operations ---

await describe('git:getWorkingDiff', () => {
  test('returns diff snapshot', async () => {
    // Make a change
    fs.writeFileSync(path.join(repoPath, 'staged.txt'), 'diff test')
    const diff = await h.invoke('git:getWorkingDiff', repoPath) as {
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
    const diff = await h.invoke('git:getWorkingDiff', repoPath) as {
      untrackedFiles: string[]
      files: string[]
    }
    expect(diff.untrackedFiles).toContain(name)
    expect(diff.files).toContain(name)
    fs.unlinkSync(path.join(repoPath, name))
  })
})

await describe('git:getUntrackedFileDiff', () => {
  test('returns diff for untracked file', async () => {
    fs.writeFileSync(path.join(repoPath, 'new-untracked.txt'), 'hello')
    const diff = await h.invoke('git:getUntrackedFileDiff', repoPath, 'new-untracked.txt') as string
    expect(diff.includes('hello')).toBe(true)
    fs.unlinkSync(path.join(repoPath, 'new-untracked.txt'))
  })

  test('returns empty string for null filePath', async () => {
    const diff = await h.invoke('git:getUntrackedFileDiff', repoPath, null as unknown as string) as string
    expect(diff).toBe('')
  })

  test('returns diff for file with unicode name', async () => {
    const name = 'protokoll från möte.txt'
    fs.writeFileSync(path.join(repoPath, name), 'unicode content')
    const diff = await h.invoke('git:getUntrackedFileDiff', repoPath, name) as string
    expect(diff.includes('unicode content')).toBe(true)
    fs.unlinkSync(path.join(repoPath, name))
  })
})

// --- Commit ---

await describe('git:commitFiles', () => {
  test('creates a commit', async () => {
    fs.writeFileSync(path.join(repoPath, 'commit-test.txt'), 'commit me')
    git('git add commit-test.txt')
    await h.invoke('git:commitFiles', repoPath, 'test commit message')
    const log = git('git log --oneline -1')
    expect(log.includes('test commit message')).toBe(true)
  })
})

// --- Merge operations ---

await describe('git:isMergeInProgress', () => {
  test('returns false when no merge', async () => {
    expect(await h.invoke('git:isMergeInProgress', repoPath)).toBe(false)
  })
})

// Set up branches for merge test
const mainBranch = git('git branch --show-current')
git('git checkout -b merge-source')
fs.writeFileSync(path.join(repoPath, 'merge-file.txt'), 'source content')
git('git add merge-file.txt')
git('git commit -m "source branch commit"')
git(`git checkout ${mainBranch}`)

await describe('git:mergeIntoParent', () => {
  test('merges clean branch', async () => {
    const result = await h.invoke('git:mergeIntoParent', repoPath, mainBranch, 'merge-source') as {
      success: boolean; merged: boolean; conflicted: boolean
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

await describe('git:mergeIntoParent (conflict)', () => {
  test('detects merge conflicts', async () => {
    const result = await h.invoke('git:mergeIntoParent', repoPath, 'conflict-a', 'conflict-b') as {
      success: boolean; conflicted: boolean; error?: string
    }
    expect(result.conflicted).toBe(true)
    expect(result.success).toBe(false)
  })
})

await describe('git:getConflictedFiles', () => {
  test('lists conflicted files', async () => {
    const files = await h.invoke('git:getConflictedFiles', repoPath) as string[]
    expect(files).toContain('conflict.txt')
  })
})

await describe('git:getConflictContent', () => {
  test('returns base/ours/theirs/merged', async () => {
    const content = await h.invoke('git:getConflictContent', repoPath, 'conflict.txt') as {
      path: string; base: string | null; ours: string | null; theirs: string | null; merged: string | null
    }
    expect(content.path).toBe('conflict.txt')
    expect(content.ours).toBeTruthy()
    expect(content.theirs).toBeTruthy()
    expect(content.merged).toBeTruthy() // Contains conflict markers
  })
})

await describe('git:writeResolvedFile', () => {
  test('writes resolved content', () => {
    h.invoke('git:writeResolvedFile', repoPath, 'conflict.txt', 'resolved content')
    const content = fs.readFileSync(path.join(repoPath, 'conflict.txt'), 'utf-8')
    expect(content).toBe('resolved content')
  })
})

await describe('git:abortMerge', () => {
  test('aborts merge in progress', async () => {
    await h.invoke('git:abortMerge', repoPath)
    expect(await h.invoke('git:isMergeInProgress', repoPath)).toBe(false)
  })
})

// --- mergeWithAI (logic only, no AI call) ---

await describe('git:mergeWithAI', () => {
  test('returns success on clean merge', async () => {
    // Create a branch that merges cleanly
    git(`git checkout ${mainBranch}`)
    git('git checkout -b clean-merge-src')
    fs.writeFileSync(path.join(repoPath, 'clean-merge.txt'), 'clean')
    git('git add clean-merge.txt')
    git('git commit -m "clean merge source"')
    git(`git checkout ${mainBranch}`)

    const result = await h.invoke('git:mergeWithAI', repoPath, repoPath, mainBranch, 'clean-merge-src') as {
      success?: boolean; resolving?: boolean
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

    const result = await h.invoke('git:mergeWithAI', repoPath, repoPath, 'ai-base', 'ai-other') as {
      resolving?: boolean; prompt?: string; conflictedFiles?: string[]
    }
    expect(result.resolving).toBe(true)
    expect(result.prompt).toBeTruthy()
    expect(result.conflictedFiles).toContain('ai-conflict.txt')

    // Clean up merge state
    git('git merge --abort')
  })
})

h.cleanup()
console.log('\nDone')
