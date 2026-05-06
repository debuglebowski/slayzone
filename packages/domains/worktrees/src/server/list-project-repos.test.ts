/**
 * Discovery tests for listProjectRepos.
 * Run via the same harness pattern as handlers.test.ts.
 */
import { test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { listProjectRepos, invalidateProjectReposCache } from './list-project-repos.js'
import { execSync } from 'child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

function git(cmd: string, cwd: string) {
  return execSync(cmd, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.com'
    }
  }).trim()
}

function makeRepo(p: string): void {
  fs.mkdirSync(p, { recursive: true })
  git('git init -q -b main', p)
  fs.writeFileSync(path.join(p, 'README.md'), '# r')
  git('git add -A', p)
  git('git commit -qm init', p)
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'slay-listrepos-'))
}

// ---------- 1: single-repo project ----------

await describe('listProjectRepos: single-repo project', () => {
  test('returns one project-root entry', async () => {
    invalidateProjectReposCache()
    const root = tmp()
    makeRepo(root)
    const entries = await listProjectRepos(root)
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('project-root')
    expect(entries[0].path).toBe(root)
    expect(entries[0].parentPath).toBeNull()
    expect(entries[0].isTaskBound).toBe(false)
    fs.rmSync(root, { recursive: true, force: true })
  })
})

// ---------- 2: multi-repo wrapper (root not git) ----------

await describe('listProjectRepos: multi-repo wrapper', () => {
  test('returns one child-repo entry per top-level git child', async () => {
    invalidateProjectReposCache()
    const root = tmp()
    makeRepo(path.join(root, 'app-a'))
    makeRepo(path.join(root, 'app-b'))
    makeRepo(path.join(root, 'service-c'))
    fs.mkdirSync(path.join(root, 'docs')) // non-git dir, ignored
    const entries = await listProjectRepos(root)
    expect(entries).toHaveLength(3)
    const names = entries.map(e => e.name).sort()
    expect(names[0]).toBe('app-a')
    expect(names[1]).toBe('app-b')
    expect(names[2]).toBe('service-c')
    expect(entries.every(e => e.kind === 'child-repo')).toBe(true)
    expect(entries.every(e => e.parentPath === null)).toBe(true)
    fs.rmSync(root, { recursive: true, force: true })
  })
})

// ---------- 3: super-repo + 2 submodules ----------

await describe('listProjectRepos: super-repo with submodules', () => {
  test('returns super + each submodule with parent linkage', async () => {
    invalidateProjectReposCache()
    // Build two donor repos for use as submodule sources (file:// URLs).
    const donorRoot = tmp()
    const donorA = path.join(donorRoot, 'donor-a')
    const donorB = path.join(donorRoot, 'donor-b')
    makeRepo(donorA)
    makeRepo(donorB)

    const root = tmp()
    makeRepo(root)
    git(`git -c protocol.file.allow=always submodule add ${donorA} sub-a`, root)
    git(`git -c protocol.file.allow=always submodule add ${donorB} libs/sub-b`, root)
    git('git commit -qm "add submodules"', root)

    const entries = await listProjectRepos(root)
    expect(entries).toHaveLength(3)
    const root_ = entries.find(e => e.kind === 'project-root')!
    const subs = entries.filter(e => e.kind === 'submodule')
    expect(root_.path).toBe(root)
    expect(root_.hasGitmodules).toBe(true)
    expect(subs).toHaveLength(2)
    expect(subs.every(s => s.parentPath === root)).toBe(true)
    const subPaths = subs.map(s => s.path).sort()
    expect(subPaths[0]).toBe(path.join(root, 'libs/sub-b'))
    expect(subPaths[1]).toBe(path.join(root, 'sub-a'))
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(donorRoot, { recursive: true, force: true })
  })
})

// ---------- 4: skip-list respected ----------

await describe('listProjectRepos: skip-list', () => {
  test('node_modules / dist children are not enumerated', async () => {
    invalidateProjectReposCache()
    const root = tmp()
    // Real git repo as a child should still be found
    makeRepo(path.join(root, 'real-app'))
    // Plant a fake repo inside node_modules — must be skipped
    makeRepo(path.join(root, 'node_modules', 'pkg'))
    makeRepo(path.join(root, 'dist', 'bundle'))
    const entries = await listProjectRepos(root)
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('real-app')
    fs.rmSync(root, { recursive: true, force: true })
  })
})

// ---------- 5: isTaskBound flips ----------

await describe('listProjectRepos: taskBoundPath', () => {
  test('flag is set on the matching entry', async () => {
    invalidateProjectReposCache()
    const root = tmp()
    makeRepo(path.join(root, 'one'))
    makeRepo(path.join(root, 'two'))
    const entries = await listProjectRepos(root, { taskBoundPath: path.join(root, 'two') })
    const bound = entries.filter(e => e.isTaskBound)
    expect(bound).toHaveLength(1)
    expect(bound[0].name).toBe('two')
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('cached entries re-annotate without re-walking', async () => {
    invalidateProjectReposCache()
    const root = tmp()
    makeRepo(path.join(root, 'one'))
    makeRepo(path.join(root, 'two'))
    const first = await listProjectRepos(root, { taskBoundPath: path.join(root, 'one') })
    expect(first.find(e => e.name === 'one')!.isTaskBound).toBe(true)
    expect(first.find(e => e.name === 'two')!.isTaskBound).toBe(false)
    // Same call w/ different bound — cached entries should re-flag
    const second = await listProjectRepos(root, { taskBoundPath: path.join(root, 'two') })
    expect(second.find(e => e.name === 'one')!.isTaskBound).toBe(false)
    expect(second.find(e => e.name === 'two')!.isTaskBound).toBe(true)
    fs.rmSync(root, { recursive: true, force: true })
  })
})

// ---------- 6a: symlinks skipped ----------

await describe('listProjectRepos: symlinks', () => {
  test('symlinked dirs are not followed (no infinite recursion / dup repos)', async () => {
    invalidateProjectReposCache()
    const root = tmp()
    makeRepo(path.join(root, 'real'))
    // Symlink pointing back at root → would be a cycle if followed
    fs.symlinkSync(root, path.join(root, 'cycle'))
    // Symlink pointing at the real repo → would dup it
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'real-link'))
    const entries = await listProjectRepos(root)
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('real')
    fs.rmSync(root, { recursive: true, force: true })
  })
})

// ---------- 6: depth cap ----------

await describe('listProjectRepos: depth cap', () => {
  test('repo deeper than MAX_CHILD_DEPTH is not found', async () => {
    invalidateProjectReposCache()
    const root = tmp()
    // Depth 4: root/a/b/c/repo  → exceeds cap of 3
    makeRepo(path.join(root, 'a', 'b', 'c', 'too-deep'))
    // Depth 2: root/x/visible  → within cap
    makeRepo(path.join(root, 'x', 'visible'))
    const entries = await listProjectRepos(root)
    const names = entries.map(e => e.name)
    expect(names.includes('a/b/c/too-deep')).toBe(false)
    expect(names.includes('x/visible')).toBe(true)
    fs.rmSync(root, { recursive: true, force: true })
  })
})
