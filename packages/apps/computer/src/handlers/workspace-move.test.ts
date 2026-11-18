import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  readlinkSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceMove } from './workspace-move'
import { jailedFs } from '../path-jail'

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-move-'))
  dirs.push(dir)
  const source = join(dir, 'source')
  const target = join(dir, 'target')
  mkdirSync(source)
  mkdirSync(target)
  git(source, 'init')
  git(source, 'config', 'user.name', 'Test')
  git(source, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(source, 'tracked'), 'base')
  git(source, 'add', '.')
  git(source, 'commit', '-m', 'base')
  git(target, 'init')
  return {
    dir,
    source,
    target,
    mover: createWorkspaceMove({ stateDir: join(dir, 'state'), roots: () => [dir] })
  }
}
async function transfer(
  mover: ReturnType<typeof createWorkspaceMove>,
  source: string,
  target: string
) {
  const manifest = await mover.snapshot({
    id: 'move-1',
    taskId: 'task-1',
    worktreePath: source,
    baseDir: null
  })
  await mover.begin({ id: 'move-2', taskId: 'task-1', projectId: 'project-1', manifest })
  for (const entry of manifest.entries)
    if (entry.type === 'file') {
      let offset = await mover.offset('move-2', entry.path)
      do {
        const chunk = await mover.read('move-1', entry.path, offset, 1024)
        offset = await mover.write('move-2', entry.path, offset, chunk)
      } while (offset < entry.size)
    }
  await mover.verify('move-2')
  return { manifest, paths: await mover.activate('move-2', target) }
}
it.skipIf(process.platform === 'win32')(
  'moves a linked worktree with staged, unstaged, ignored, binary and executable files',
  async () => {
    const { dir, source, target, mover } = fixture()
    const worktree = join(dir, 'worktree')
    git(source, 'worktree', 'add', '-b', 'feature', worktree)
    writeFileSync(join(worktree, 'tracked'), 'staged')
    git(worktree, 'add', 'tracked')
    writeFileSync(join(worktree, 'tracked'), 'unstaged')
    writeFileSync(join(worktree, '.gitignore'), 'ignored\n')
    writeFileSync(join(worktree, 'ignored'), Buffer.from([0, 255, 1]))
    writeFileSync(join(worktree, 'run'), '#!/bin/sh\n', { mode: 0o755 })
    symlinkSync('tracked', join(worktree, 'link'))
    mkdirSync(join(worktree, 'private'), { mode: 0o700 })
    writeFileSync(join(worktree, 'private', 'config'), 'private settings')
    const before = git(worktree, 'status', '--porcelain=v1', '--untracked-files=all')
    const { paths } = await transfer(mover, worktree, target)
    expect(paths.worktreePath).toBeTruthy()
    const moved = paths.worktreePath!
    expect(git(moved, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(before)
    expect(git(moved, 'show', ':tracked')).toBe('staged')
    expect(readFileSync(join(moved, 'tracked'), 'utf8')).toBe('unstaged')
    expect(readFileSync(join(moved, 'ignored'))).toEqual(Buffer.from([0, 255, 1]))
    expect(readlinkSync(join(moved, 'link'))).toBe('tracked')
    expect(statSync(join(moved, 'run')).mode & 0o111).toBeTruthy()
    expect(statSync(join(moved, 'private')).mode & 0o777).toBe(0o700)
    expect(git(target, 'worktree', 'list', '--porcelain')).toContain(moved)
    expect(existsSync(join(worktree, 'tracked'))).toBe(true)
    expect(await mover.activate('move-2', target)).toEqual(paths)
    await mover.verifyDestination('move-2')
    writeFileSync(join(moved, 'tracked'), 'unexpected destination edit')
    await expect(mover.verifyDestination('move-2')).rejects.toThrow(/verification/i)
  }
)
it('never overwrites an interrupted destination when activation is retried', async () => {
  const { source, target, mover } = fixture()
  const install = jailedFs.installVerifiedFile
  const fail = vi
    .spyOn(jailedFs, 'installVerifiedFile')
    .mockImplementation(async (from, to, mode, replace) => {
      if (to.endsWith(join('worktree', 'tracked'))) throw new Error('Disk disconnected')
      return install(from, to, mode, replace)
    })
  await expect(transfer(mover, source, target)).rejects.toThrow('Disk disconnected')
  const interrupted = join(target, '.slayzone', 'moved-tasks', 'move-2', '1', 'worktree', 'tracked')
  writeFileSync(interrupted, 'keep recovery edit')
  fail.mockRestore()
  const result = await mover.activate('move-2', target)
  expect(result.worktreePath).toContain(join('2', 'worktree'))
  expect(readFileSync(interrupted, 'utf8')).toBe('keep recovery edit')
})
it('detects staged-only changes even when working files and porcelain status stay the same', async () => {
  const { source, mover } = fixture()
  writeFileSync(join(source, 'tracked'), 'stage one')
  git(source, 'add', 'tracked')
  writeFileSync(join(source, 'tracked'), 'working')
  await mover.snapshot({ id: 'move-1', taskId: 'task-1', worktreePath: source, baseDir: null })
  const status = git(source, 'status', '--porcelain')
  writeFileSync(join(source, 'tracked'), 'stage two')
  git(source, 'add', 'tracked')
  writeFileSync(join(source, 'tracked'), 'working')
  expect(git(source, 'status', '--porcelain')).toBe(status)
  await expect(mover.verifySource('move-1')).rejects.toThrow(/changed/i)
})
it('preserves unresolved merges and detects later edits to merge metadata', async () => {
  const { source, target, mover } = fixture()
  const main = git(source, 'branch', '--show-current')
  git(source, 'checkout', '-b', 'other')
  writeFileSync(join(source, 'tracked'), 'other')
  git(source, 'add', '.')
  git(source, 'commit', '-m', 'other')
  git(source, 'checkout', main)
  writeFileSync(join(source, 'tracked'), 'ours')
  git(source, 'add', '.')
  git(source, 'commit', '-m', 'ours')
  expect(() => git(source, 'merge', 'other')).toThrow()
  const { paths } = await transfer(mover, source, target)
  expect(git(paths.worktreePath!, 'ls-files', '--unmerged')).toBe(
    git(source, 'ls-files', '--unmerged')
  )
  expect(git(paths.worktreePath!, 'rev-parse', 'MERGE_HEAD')).toBe(
    git(source, 'rev-parse', 'MERGE_HEAD')
  )
  writeFileSync(join(source, '.git', 'MERGE_MSG'), 'edited merge message')
  await expect(mover.verifySource('move-1')).rejects.toThrow(/changed/i)
})
it('rejects corrupt transfers and traversal without touching source', async () => {
  const { source, mover } = fixture()
  const manifest = await mover.snapshot({
    id: 'move-1',
    taskId: 'task-1',
    worktreePath: source,
    baseDir: null
  })
  await mover.begin({ id: 'move-2', taskId: 'task-1', projectId: 'project-1', manifest })
  await expect(mover.write('move-2', '../escape', 0, 'YQ==')).rejects.toThrow()
  const file = manifest.entries.find((e) => e.type === 'file' && e.size > 0)!
  await mover.write('move-2', file.path, 0, Buffer.alloc(file.size).toString('base64'))
  await expect(mover.verify('move-2')).rejects.toThrow()
  expect(readFileSync(join(source, 'tracked'), 'utf8')).toBe('base')
})
it('resumes partial files after recreating native handler and refuses source changes', async () => {
  const { dir, source, mover } = fixture()
  const manifest = await mover.snapshot({
    id: 'move-1',
    taskId: 'task-1',
    worktreePath: source,
    baseDir: null
  })
  await mover.begin({ id: 'move-2', taskId: 'task-1', projectId: 'project-1', manifest })
  const file = manifest.entries.find((e) => e.type === 'file' && e.size > 2)!
  await mover.write('move-2', file.path, 0, await mover.read('move-1', file.path, 0, 2))
  const restarted = createWorkspaceMove({ stateDir: join(dir, 'state'), roots: () => [dir] })
  expect(await restarted.offset('move-2', file.path)).toBe(2)
  writeFileSync(join(source, 'tracked'), 'external edit')
  await expect(restarted.verifySource('move-1')).rejects.toThrow(/changed/i)
})
