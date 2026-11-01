import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceSnapshotManager } from './workspace-capture'

describe('workspace capture', () => {
  let root: string
  let snapshots: WorkspaceSnapshotManager
  const id = 'c765cc02-2707-44aa-a7ca-2bfd0f6e7c5a'
  const scope = 'tab-1:gen-1'
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'workspace-capture-test-'))
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    writeFileSync(join(root, 'config.ts'), 'const retries = 1\n')
    git('add', '.')
    git('commit', '-qm', 'initial')
    snapshots = new WorkspaceSnapshotManager()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  it('captures shell-written changes against the dirty baseline, preserving the index', async () => {
    writeFileSync(join(root, 'config.ts'), 'const retries = 2\n')
    git('add', 'config.ts')
    const index = git('ls-files', '--stage')
    expect((await snapshots.begin({ id, scope, rootPath: root })).status).toBe('ready')
    execFileSync('python3', ['-c', "open('config.ts','w').write('const retries = 3\\n')"], {
      cwd: root
    })
    const result = await snapshots.finish({ id, scope, rootPath: root })
    expect(result.status).toBe('complete')
    expect(result.files).toEqual([
      expect.objectContaining({ path: 'config.ts', additions: 1, deletions: 1 })
    ])
    expect(result.files[0].diff).toContain('-const retries = 2')
    expect(result.files[0].diff).not.toContain('-const retries = 1')
    expect(git('ls-files', '--stage')).toBe(index)
    expect(readFileSync(join(root, 'config.ts'), 'utf8')).toBe('const retries = 3\n')
    git('add', '.')
    git('commit', '-qm', 'land changes')
    expect((await snapshots.finish({ id, scope, rootPath: root })).files[0].diff).toBe(
      result.files[0].diff
    )
  })

  it('preserves a clean baseline and includes new/deleted files, but excludes ignored files', async () => {
    writeFileSync(join(root, '.gitignore'), 'ignored.txt\n')
    await snapshots.begin({ id, scope, rootPath: root })
    rmSync(join(root, 'config.ts'))
    writeFileSync(join(root, 'new file.txt'), 'new\n')
    writeFileSync(join(root, 'ignored.txt'), 'ignored\n')
    const result = await snapshots.finish({ id, scope, rootPath: root })
    expect(result.files.map((f) => [f.path, f.kind])).toEqual([
      ['config.ts', 'deleted'],
      ['new file.txt', 'added']
    ])
    expect(result.status).toBe('complete')
  })

  it('binds references to the capture scope and makes begin/finish idempotent', async () => {
    await snapshots.begin({ id, scope, rootPath: root })
    writeFileSync(join(root, 'config.ts'), 'changed\n')
    await snapshots.begin({ id, scope, rootPath: root })
    expect((await snapshots.finish({ id, scope: 'another-tab', rootPath: root })).status).toBe(
      'unavailable'
    )
    const result = await snapshots.finish({ id, scope, rootPath: root })
    writeFileSync(join(root, 'config.ts'), 'later change\n')
    expect(await snapshots.finish({ id, scope, rootPath: root })).toEqual(result)
    await snapshots.discard({ id, scope, rootPath: root })
    expect(git('for-each-ref', '--format=%(refname)', 'refs/slayzone/workspace-captures')).toBe('')
  })

  it('supports new repositories without HEAD and binary metadata', async () => {
    git('checkout', '--orphan', 'empty')
    git('rm', '-rf', '.')
    await snapshots.begin({ id, scope, rootPath: root })
    writeFileSync(join(root, 'image.bin'), Buffer.from([0, 1, 2, 3]))
    const result = await snapshots.finish({ id, scope, rootPath: root })
    expect(result.status).toBe('complete')
    expect(result.files[0]).toMatchObject({
      path: 'image.bin',
      binary: true,
      diff: null,
      additions: null
    })
  })

  it('marks oversized text diffs partial instead of claiming no changes', async () => {
    await snapshots.begin({ id, scope, rootPath: root })
    writeFileSync(join(root, 'large.txt'), 'x'.repeat(1024 * 1024 + 20))
    const result = await snapshots.finish({ id, scope, rootPath: root })
    expect(result.status).toBe('partial')
    expect(result.files[0]).toMatchObject({ path: 'large.txt', diff: null, omitted: 'size-limit' })
  })

  it('reports a missing baseline and non-Git folders as unavailable', async () => {
    expect((await snapshots.finish({ id, scope, rootPath: root })).status).toBe('unavailable')
    rmSync(join(root, '.git'), { recursive: true, force: true })
    expect((await snapshots.begin({ id, scope, rootPath: root })).status).toBe('unavailable')
  })

  it('captures renames and unusual filenames without relying on shell quoting', async () => {
    await snapshots.begin({ id, scope, rootPath: root })
    renameSync(join(root, 'config.ts'), join(root, 'renamed\t配置.ts'))
    const result = await snapshots.finish({ id, scope, rootPath: root })
    expect(result.files[0]).toMatchObject({
      kind: 'renamed',
      oldPath: 'config.ts',
      path: 'renamed\t配置.ts',
      additions: 0,
      deletions: 0
    })
    expect(result.files[0].diff).toContain('rename from config.ts')
  })

  it('caps the total diff payload and marks every omitted file', async () => {
    await snapshots.begin({ id, scope, rootPath: root })
    for (let i = 0; i < 6; i++) writeFileSync(join(root, `large-${i}.txt`), 'x'.repeat(900_000))
    const result = await snapshots.finish({ id, scope, rootPath: root })
    expect(result.status).toBe('partial')
    expect(result.files).toHaveLength(6)
    expect(
      result.files.reduce((bytes, f) => bytes + Buffer.byteLength(f.diff ?? ''), 0)
    ).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(
      result.files.filter((f) => f.diff === null).every((f) => f.omitted === 'size-limit')
    ).toBe(true)
  })

  it('ignores inherited Git redirects instead of writing to the host index', async () => {
    vi.stubEnv('GIT_DIR', '/nonexistent/git-dir')
    vi.stubEnv('GIT_WORK_TREE', '/nonexistent/work-tree')
    vi.stubEnv('GIT_INDEX_FILE', join(root, 'host-index'))
    expect((await snapshots.begin({ id, scope, rootPath: root })).status).toBe('ready')
    writeFileSync(join(root, 'config.ts'), 'observed\n')
    expect((await snapshots.finish({ id, scope, rootPath: root })).files[0].path).toBe('config.ts')
  })
})
