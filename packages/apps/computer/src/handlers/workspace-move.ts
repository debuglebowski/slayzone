/** Immutable computer-owned workspace snapshots, resumable file transfer, verified activation.
 * Source folders are never removed. Linked worktrees become registered worktrees of
 * the destination project; their index and all work files (including ignored files) survive.
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants, createWriteStream } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import {
  workspaceManifestSchema,
  workspaceEntrySchema,
  type WorkspaceEntry,
  type WorkspaceManifest
} from '@slayzone/computer-transport/shared'
import { jailedFs, judgePath } from '../path-jail'

type Paths = { worktreePath: string | null; baseDir: string | null }
type Record = {
  taskId: string
  projectId?: string
  manifest: WorkspaceManifest
  source?: Paths
  fingerprint?: WorkspaceEntry[]
  activated?: Paths
  activating?: Paths
  installed?: string[]
  attempt?: number
}
const gitStateFile = (name: string) =>
  name === 'index' ||
  /^sharedindex\.[a-f0-9]+$/.test(name) ||
  [
    'MERGE_HEAD',
    'MERGE_MSG',
    'MERGE_MODE',
    'AUTO_MERGE',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'ORIG_HEAD',
    'SQUASH_MSG'
  ].includes(name)
const safeId = (id: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error('Invalid move id')
  return id
}
async function git(cwd: string, args: string[], output?: string, input?: string): Promise<string> {
  const child = spawn('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stdin.on('error', () => {
    /* Exit status reports Git failures. */
  })
  child.stdin.end(input ?? '')
  const chunks: Buffer[] = []
  const errors: Buffer[] = []
  child.stderr.on('data', (c: Buffer) => errors.push(c))
  const completed = new Promise<void>((yes, no) => {
    child.on('error', no)
    child.on('close', (code) =>
      code === 0 ? yes() : no(new Error(`git ${args[0]}: ${Buffer.concat(errors).toString()}`))
    )
  })
  if (output)
    await Promise.all([
      pipeline(child.stdout, createWriteStream(output, { flags: 'wx' })),
      completed
    ])
  else {
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    await completed
  }
  return Buffer.concat(chunks).toString('utf8').trim()
}
async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    for await (const chunk of file.createReadStream({ autoClose: false })) h.update(chunk)
  } finally {
    await file.close()
  }
  return h.digest('hex')
}
const missing = async (path: string) => {
  try {
    await lstat(path)
    return false
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw e
  }
}

export function createWorkspaceMove(opts: { stateDir: string; roots(): readonly string[] }) {
  const root = join(opts.stateDir, 'workspace-moves')
  const directory = (id: string) => join(root, safeId(id))
  const records = new Map<string, Record>()
  const fileIndexes = new WeakMap<WorkspaceManifest, Map<string, WorkspaceEntry>>()
  const load = async (id: string): Promise<Record> => {
    const cached = records.get(id)
    if (cached) return cached
    const record: Record = JSON.parse(await readFile(join(directory(id), 'record.json'), 'utf8'))
    records.set(id, record)
    return record
  }
  const save = async (id: string, record: Record) => {
    await mkdir(directory(id), { recursive: true, mode: 0o700 })
    const tmp = join(directory(id), 'record.tmp')
    await writeFile(tmp, JSON.stringify(record), { mode: 0o600 })
    await rename(tmp, join(directory(id), 'record.json'))
    records.set(id, record)
  }
  const entriesOf = async (folder: string, source = false): Promise<WorkspaceEntry[]> => {
    const entries: WorkspaceEntry[] = []
    const walk = async (dir: string) => {
      for (const name of (await readdir(dir)).sort()) {
        if (source && name === '.git') continue
        const path = join(dir, name)
        if (source) judgePath(path, opts.roots(), { access: 'entry', subtree: false })
        const s = await lstat(path)
        const rel = relative(folder, path).split(sep).join('/')
        if (s.isDirectory()) {
          entries.push({ path: rel, type: 'directory', size: 0, mode: s.mode & 0o777, hash: '' })
          await walk(path)
        } else if (s.isSymbolicLink())
          entries.push({
            path: rel,
            type: 'symlink',
            size: 0,
            mode: s.mode & 0o777,
            hash: '',
            link: await readlink(path)
          })
        else if (s.isFile())
          entries.push({
            path: rel,
            type: 'file',
            size: s.size,
            mode: s.mode & 0o777,
            hash: await hashFile(path)
          })
        else throw new Error(`Cannot migrate special file: ${rel}`)
      }
    }
    await walk(folder)
    return entries
  }
  async function copyTree(source: string, target: string) {
    await mkdir(target, { recursive: true })
    for (const entry of await entriesOf(source, true)) {
      const from = join(source, entry.path)
      const to = join(target, entry.path)
      if (entry.type === 'directory') await mkdir(to, { recursive: true })
      else if (entry.type === 'symlink') await symlink(entry.link!, to)
      else {
        await copyFile(from, to, constants.COPYFILE_EXCL)
        await chmod(to, entry.mode)
      }
    }
  }
  async function snapshotRepo(
    source: string,
    target: string
  ): Promise<{ git: boolean; head?: string; branch?: string }> {
    if (await missing(join(source, '.git'))) return { git: false }
    const originalGitState = JSON.parse(await gitFingerprint(source)).slice(1)
    // Git subprocesses may read a worktree's administrative directory outside the
    // worktree. Judge both git directories against the machine bound first.
    const gitDir = judgePath(await git(source, ['rev-parse', '--absolute-git-dir']), opts.roots())
    const common = await git(source, ['rev-parse', '--git-common-dir'])
    judgePath(resolve(source, common), opts.roots())
    if (!(await missing(join(gitDir, 'index.lock'))))
      throw new Error('Git index is locked; finish the current Git operation first.')
    const format = await git(source, ['rev-parse', '--show-object-format'])
    for (const name of ['rebase-merge', 'rebase-apply', 'sequencer'])
      if (!(await missing(join(gitDir, name))))
        throw new Error(
          'Finish or abort the current rebase/cherry-pick sequence before moving this task.'
        )
    await git(target, ['init', '--template=', `--object-format=${format}`])
    const headText = await readFile(judgePath(join(gitDir, 'HEAD'), opts.roots()), 'utf8')
    const branch = headText.startsWith('ref: refs/heads/')
      ? headText.trim().slice('ref: refs/heads/'.length)
      : undefined
    let head: string | undefined
    try {
      head = await git(source, ['rev-parse', '--verify', 'HEAD'])
    } catch {
      /* Unborn repository. */
    }
    const pack = join(target, '.git', 'objects', 'incoming.pack')
    const revisions = new Set(head ? [head] : [])
    for (const name of ['MERGE_HEAD', 'AUTO_MERGE', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
      const file = join(gitDir, name)
      if (!(await missing(file)))
        for (const oid of (await readFile(file, 'utf8')).trim().split('\n')) {
          if (/^[a-f0-9]{40,64}$/.test(oid)) revisions.add(oid)
        }
    }
    await git(
      source,
      ['pack-objects', '--stdout', '--revs', '--all', '--reflog', '--indexed-objects'],
      pack,
      [...revisions].map((oid) => `${oid}\n`).join('')
    )
    const packHash = await git(target, ['index-pack', pack])
    await rename(pack, join(target, '.git', 'objects', 'pack', `pack-${packHash}.pack`))
    await rename(
      pack.replace(/\.pack$/, '.idx'),
      join(target, '.git', 'objects', 'pack', `pack-${packHash}.idx`)
    )
    const refs = await git(source, ['for-each-ref', '--format=%(objectname) %(refname)'])
    for (const line of refs.split('\n').filter(Boolean)) {
      const [oid, ref] = line.split(' ')
      await git(target, ['update-ref', ref, oid])
    }
    await writeFile(join(target, '.git', 'HEAD'), headText)
    for (const name of await readdir(gitDir))
      if (gitStateFile(name))
        await copyFile(judgePath(join(gitDir, name), opts.roots()), join(target, '.git', name))
    let config = ''
    try {
      config = await git(source, [
        'config',
        '--local',
        '-z',
        '--get-regexp',
        '^(remote\\..*\\.(url|pushurl|fetch)|branch\\..*\\.(remote|merge|pushRemote))$'
      ])
    } catch {
      /* No remote/tracking config. */
    }
    for (const entry of config.split('\0').filter(Boolean)) {
      const split = entry.indexOf('\n')
      if (split > 0)
        await git(target, [
          'config',
          '--local',
          '--add',
          entry.slice(0, split),
          entry.slice(split + 1)
        ])
    }
    if (
      JSON.stringify(originalGitState) !==
      JSON.stringify(JSON.parse(await gitFingerprint(target, true)).slice(1))
    )
      throw new Error('Git state changed while copying its snapshot; retry after stopping edits.')
    // Nested repositories are converted separately below; machine-specific .git
    // pointers never enter the transferable snapshot.
    return { git: true, head, branch }
  }
  async function gitFingerprint(source: string, internal = false): Promise<string> {
    const rawGitDir = await git(source, ['rev-parse', '--absolute-git-dir'])
    const gitDir = internal ? rawGitDir : judgePath(rawGitDir, opts.roots())
    const metadata: Array<[string, string]> = []
    for (const name of (await readdir(gitDir)).sort()) {
      if (gitStateFile(name) && name !== 'index' && !name.startsWith('sharedindex.'))
        metadata.push([
          name,
          await hashFile(
            internal ? join(gitDir, name) : judgePath(join(gitDir, name), opts.roots())
          )
        ])
      if (['rebase-merge', 'rebase-apply', 'sequencer'].includes(name))
        metadata.push([name, 'in-progress'])
    }
    return JSON.stringify(
      await Promise.all([
        git(source, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']),
        git(source, ['ls-files', '--stage', '-z']),
        git(source, ['ls-files', '-v', '-z']),
        Promise.resolve(metadata)
      ])
    )
  }
  const fileOf = async (id: string, path: string) => {
    workspaceEntrySchema.shape.path.parse(path)
    const record = await load(id)
    let files = fileIndexes.get(record.manifest)
    if (!files) {
      files = new Map(record.manifest.entries.map((e) => [e.path, e]))
      fileIndexes.set(record.manifest, files)
    }
    const entry = files.get(path)
    if (!entry || entry.type !== 'file') throw new Error('File is not in this workspace snapshot')
    return { entry, record, path: join(directory(id), 'files', path) }
  }
  const api = {
    async snapshot(input: { id: string; taskId: string } & Paths): Promise<WorkspaceManifest> {
      if (!(await missing(join(directory(input.id), 'record.json'))))
        return (await load(input.id)).manifest
      const folder = join(directory(input.id), 'files')
      await rm(directory(input.id), { recursive: true, force: true })
      await mkdir(folder, { recursive: true, mode: 0o700 })
      const roots: WorkspaceManifest['roots'] = []
      const fingerprint: WorkspaceEntry[] = []
      const originals = new Map<string, WorkspaceEntry>()
      for (const [key, path] of [
        ['worktree', input.worktreePath],
        ['base', input.baseDir]
      ] as const) {
        if (!path) continue
        if (key === 'base' && path === input.worktreePath) {
          roots.push({ key, git: false, sameAs: 'worktree' })
          continue
        }
        const source = judgePath(path, opts.roots())
        if (!(await stat(source)).isDirectory()) throw new Error('Task folder is not a directory')
        const before = await entriesOf(source, true)
        originals.set(key, {
          path: key,
          type: 'directory',
          size: 0,
          mode: (await stat(source)).mode & 0o777,
          hash: ''
        })
        for (const entry of before)
          originals.set(`${key}/${entry.path}`, { ...entry, path: `${key}/${entry.path}` })
        const gitBefore = (await missing(join(source, '.git')))
          ? null
          : await gitFingerprint(source)
        // All nested Git repositories are converted too (submodules, vendored repos).
        await copyTree(source, join(folder, key))
        const repo = await snapshotRepo(source, join(folder, key))
        roots.push({ key, ...repo })
        const convertNested = async (dir: string) => {
          for (const child of await readdir(dir, { withFileTypes: true }))
            if (child.isDirectory() && child.name !== '.git') {
              const nested = join(dir, child.name)
              if (!(await missing(join(nested, '.git'))))
                await snapshotRepo(nested, join(folder, key, relative(source, nested)))
              await convertNested(nested)
            }
        }
        await convertNested(source)
        if (JSON.stringify(before) !== JSON.stringify(await entriesOf(source, true)))
          throw new Error('Source files changed while snapshotting; retry after stopping edits.')
        fingerprint.push(...before.map((e) => ({ ...e, path: `${key}/${e.path}` })))
        if (repo.git) {
          if (gitBefore !== (await gitFingerprint(source)))
            throw new Error(
              'Source Git state changed while snapshotting; retry after stopping edits.'
            )
          fingerprint.push({
            path: `${key}/.git-state`,
            type: 'file',
            mode: 0,
            size: 0,
            hash: gitBefore!
          })
        }
      }
      const entries = await entriesOf(folder)
      const copied = new Map(entries.map((entry) => [entry.path, entry]))
      for (const [path, original] of originals) {
        const entry = copied.get(path)
        if (
          !entry ||
          entry.type !== original.type ||
          entry.hash !== original.hash ||
          entry.size !== original.size ||
          entry.link !== original.link
        )
          throw new Error(`Source changed while copying: ${path}`)
        // Staging directories remain writable; the manifest carries original modes.
        entry.mode = original.mode
      }
      const manifest = { roots, entries, totalBytes: entries.reduce((n, e) => n + e.size, 0) }
      await save(input.id, { taskId: input.taskId, source: input, manifest, fingerprint })
      return manifest
    },
    async begin(input: {
      id: string
      taskId: string
      projectId: string
      manifest: WorkspaceManifest
    }) {
      const manifest = workspaceManifestSchema.parse(input.manifest)
      if (!(await missing(join(directory(input.id), 'record.json')))) {
        const old = await load(input.id)
        if (old.source) throw new Error('Source workspace snapshots are immutable')
        if (
          old.taskId !== input.taskId ||
          JSON.stringify(old.manifest) !== JSON.stringify(manifest)
        )
          throw new Error('Workspace transfer already has different content')
        return
      }
      if (new Set(manifest.entries.map((e) => e.path)).size !== manifest.entries.length)
        throw new Error('Duplicate workspace entries')
      const leaves = new Set(
        manifest.entries.filter((e) => e.type !== 'directory').map((e) => e.path)
      )
      for (const entry of manifest.entries) {
        let parent = entry.path.lastIndexOf('/')
        while (parent > 0) {
          if (leaves.has(entry.path.slice(0, parent)))
            throw new Error('Workspace entry traverses a file or symlink')
          parent = entry.path.lastIndexOf('/', parent - 1)
        }
      }
      if (
        manifest.entries.some(
          (e) =>
            !manifest.roots.some(
              (r) => !r.sameAs && (e.path === r.key || e.path.startsWith(`${r.key}/`))
            )
        )
      )
        throw new Error('Workspace entry outside its roots')
      await mkdir(join(directory(input.id), 'files'), { recursive: true, mode: 0o700 })
      for (const e of manifest.entries
        .filter((e) => e.type === 'directory')
        .sort((a, b) => a.path.length - b.path.length))
        await mkdir(join(directory(input.id), 'files', e.path), { recursive: true })
      await save(input.id, { taskId: input.taskId, projectId: input.projectId, manifest })
    },
    async offset(id: string, path: string) {
      const file = await fileOf(id, path)
      if (file.record.source) throw new Error('Source workspace snapshots are immutable')
      if (await missing(file.path)) return 0
      const size = (await stat(file.path)).size
      if (
        size > file.entry.size ||
        (size === file.entry.size && (await hashFile(file.path)) !== file.entry.hash)
      ) {
        const fd = await open(
          file.path,
          constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW
        )
        await fd.close()
        return 0
      }
      return size
    },
    async read(id: string, path: string, offset: number, length: number) {
      const file = await fileOf(id, path)
      const fd = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const data = Buffer.alloc(Math.min(length, 256 * 1024))
        const r = await fd.read(data, 0, data.length, offset)
        return data.subarray(0, r.bytesRead).toString('base64')
      } finally {
        await fd.close()
      }
    },
    async write(id: string, path: string, offset: number, data: string) {
      const file = await fileOf(id, path)
      if (file.record.source) throw new Error('Source workspace snapshots are immutable')
      const bytes = Buffer.from(data, 'base64')
      if (offset + bytes.length > file.entry.size)
        throw new Error('Workspace file exceeds manifest size')
      await mkdir(dirname(file.path), { recursive: true })
      const fd = await open(
        file.path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600
      )
      try {
        const size = (await fd.stat()).size
        if (size !== offset) throw new Error('Workspace offset changed; retry transfer')
        let n = 0
        while (n < bytes.length)
          n += (await fd.write(bytes, n, bytes.length - n, offset + n)).bytesWritten
        if (offset + bytes.length === file.entry.size) await fd.sync()
        return offset + bytes.length
      } finally {
        await fd.close()
      }
    },
    async verify(id: string) {
      const record = await load(id)
      for (const e of record.manifest.entries)
        if (e.type === 'file') {
          const p = join(directory(id), 'files', e.path)
          if (
            (await missing(p)) ||
            (await stat(p)).size !== e.size ||
            (await hashFile(p)) !== e.hash
          )
            throw new Error(`Workspace checksum mismatch: ${e.path}`)
        }
    },
    async verifySource(id: string) {
      const record = await load(id)
      if (!record.source) throw new Error('Not a source snapshot')
      const now: WorkspaceEntry[] = []
      for (const r of record.manifest.roots) {
        if (r.sameAs) continue
        const path = r.key === 'worktree' ? record.source.worktreePath! : record.source.baseDir!
        judgePath(path, opts.roots())
        now.push(
          ...(await entriesOf(path, true)).map((e) => ({ ...e, path: `${r.key}/${e.path}` }))
        )
        if (r.git)
          now.push({
            path: `${r.key}/.git-state`,
            type: 'file',
            mode: 0,
            size: 0,
            hash: await gitFingerprint(path)
          })
      }
      if (JSON.stringify(now) !== JSON.stringify(record.fingerprint))
        throw new Error(
          'Source files changed since snapshot; cancel and start again to include the latest edits.'
        )
    },
    async verifyDestination(id: string) {
      const record = await load(id)
      if (!record.activated) throw new Error('Destination workspace is not installed')
      for (const root of record.manifest.roots) {
        if (root.sameAs) continue
        const dest =
          root.key === 'worktree' ? record.activated.worktreePath! : record.activated.baseDir!
        const linked = root.key === 'worktree' && root.git && root.head
        const gitDir = linked ? await git(dest, ['rev-parse', '--absolute-git-dir']) : null
        if (linked)
          for (const args of [
            ['ls-files', '--stage', '-z'],
            ['ls-files', '-v', '-z']
          ]) {
            if (
              (await git(dest, args)) !== (await git(join(directory(id), 'files', root.key), args))
            )
              throw new Error('Destination Git index failed verification')
          }
        for (const entry of record.manifest.entries.filter((e) =>
          e.path.startsWith(`${root.key}/`)
        )) {
          const suffix = entry.path.slice(root.key.length + 1)
          let path = join(dest, suffix)
          if (linked && (suffix === '.git' || suffix.startsWith('.git/'))) {
            if (
              !gitStateFile(suffix.slice(5)) ||
              suffix === '.git/index' ||
              suffix.startsWith('.git/sharedindex.')
            )
              continue
            path = join(gitDir!, suffix.slice(5))
          }
          judgePath(path, opts.roots(), { access: 'entry' })
          const info = await lstat(path)
          const valid =
            entry.type === 'file'
              ? info.isFile() && info.size === entry.size && (await hashFile(path)) === entry.hash
              : entry.type === 'directory'
                ? info.isDirectory()
                : info.isSymbolicLink() && (await readlink(path)) === entry.link
          if (!valid)
            throw new Error(`Destination workspace changed or failed verification: ${entry.path}`)
        }
      }
    },
    async activate(id: string, projectRoot: string): Promise<Paths> {
      const record = await load(id)
      if (record.source) throw new Error('Source workspace snapshots are immutable')
      if (record.activated) return record.activated
      await api.verify(id)
      const project = judgePath(projectRoot, opts.roots())
      record.attempt = (record.attempt ?? 0) + 1
      record.installed = []
      const base = judgePath(
        join(project, '.slayzone', 'moved-tasks', safeId(id), String(record.attempt)),
        opts.roots(),
        { access: 'write', newRoot: true }
      )
      const paths: Paths = { worktreePath: null, baseDir: null }
      for (const r of record.manifest.roots) {
        const path = join(base, r.key)
        if (r.key === 'worktree') paths.worktreePath = path
        else paths.baseDir = r.sameAs ? paths.worktreePath : path
      }
      record.activating = paths
      await save(id, record)
      for (const r of record.manifest.roots) {
        if (r.sameAs) continue
        const dest = r.key === 'worktree' ? paths.worktreePath! : paths.baseDir!
        const snapshot = join(directory(id), 'files', r.key)
        // Recovery may find a fully installed root after a lost acknowledgement.
        if (record.installed?.includes(r.key)) continue
        if (!(await missing(dest)))
          throw new Error(
            'Destination folder already exists; retry will create a separate recovery copy.'
          )
        jailedFs.mkdir(judgePath(dirname(dest), opts.roots(), { access: 'write', newRoot: true }))
        if (r.key === 'worktree' && r.git && r.head) {
          const common = judgePath(
            resolve(project, await git(project, ['rev-parse', '--git-common-dir'])),
            opts.roots(),
            { access: 'write' }
          )
          const objectPacks = join(common, 'objects', 'pack')
          jailedFs.mkdir(judgePath(objectPacks, opts.roots(), { access: 'write' }))
          // Fetch sends only reachable objects. The index can also refer to new,
          // uncommitted blobs, so retain the verified self-contained pack too.
          for (const name of await readdir(join(snapshot, '.git', 'objects', 'pack'))) {
            if (!/^pack-[a-f0-9]+\.(pack|idx)$/.test(name)) throw new Error('Invalid Git pack name')
            const from = join(snapshot, '.git', 'objects', 'pack', name)
            const to = join(objectPacks, name)
            if (await missing(to))
              await jailedFs.installVerifiedFile(
                from,
                judgePath(to, opts.roots(), { access: 'write' }),
                0o444
              )
            else if ((await hashFile(from)) !== (await hashFile(to)))
              throw new Error('Destination Git pack differs')
          }
          await git(project, [
            'fetch',
            '--no-write-fetch-head',
            snapshot,
            `+refs/*:refs/slayzone-moves/${safeId(id)}/*`,
            `+HEAD:refs/slayzone-moves/${safeId(id)}/HEAD`
          ])
          const branch = `${(r.branch ?? 'task').slice(0, 80).replace(/\/+$/, '')}-moved-${safeId(id)}-${record.attempt}`
          await git(project, ['worktree', 'add', '--no-checkout', '-b', branch, dest, r.head])
          jailedFs.setDirectoryMode(judgePath(dest, opts.roots(), { access: 'entry' }), 0o700)
          // Copy exact worktree files; transplant the original index so staged,
          // unstaged, conflicts and intent-to-add remain distinct.
          for (const entry of record.manifest.entries.filter(
            (e) =>
              e.path.startsWith(`${r.key}/`) &&
              !e.path.startsWith(`${r.key}/.git/`) &&
              e.path !== `${r.key}/.git`
          )) {
            const to = join(base, entry.path)
            if (entry.type === 'directory')
              jailedFs.mkdir(judgePath(to, opts.roots(), { access: 'write' }))
            else if (entry.type === 'file')
              await jailedFs.installVerifiedFile(
                join(directory(id), 'files', entry.path),
                judgePath(to, opts.roots(), { access: 'write' }),
                entry.mode
              )
          }
          const gitDir = await git(dest, ['rev-parse', '--absolute-git-dir'])
          for (const name of await readdir(join(snapshot, '.git')))
            if (gitStateFile(name))
              await jailedFs.installVerifiedFile(
                join(snapshot, '.git', name),
                judgePath(join(gitDir, name), opts.roots(), { access: 'write' }),
                0o644,
                true
              )
        } else {
          jailedFs.mkdir(judgePath(dest, opts.roots(), { access: 'write', newRoot: true }))
          jailedFs.setDirectoryMode(judgePath(dest, opts.roots(), { access: 'entry' }), 0o700)
          // Private snapshot has only manifest-verified entries, no followed links.
          for (const entry of record.manifest.entries.filter((e) =>
            e.path.startsWith(`${r.key}/`)
          )) {
            const to = join(base, entry.path)
            if (entry.type === 'directory')
              jailedFs.mkdir(judgePath(to, opts.roots(), { access: 'write' }))
            else if (entry.type === 'file')
              await jailedFs.installVerifiedFile(
                join(directory(id), 'files', entry.path),
                judgePath(to, opts.roots(), { access: 'write' }),
                entry.mode
              )
          }
        }
        // Links are installed last; no write ever follows one from the manifest.
        for (const entry of record.manifest.entries.filter(
          (e) => e.type === 'symlink' && e.path.startsWith(`${r.key}/`)
        )) {
          const to = join(base, entry.path)
          if (await missing(to))
            jailedFs.createSymlink(judgePath(to, opts.roots(), { access: 'entry' }), entry.link!)
        }
        record.installed = [...(record.installed ?? []), r.key]
        for (const entry of record.manifest.entries
          .filter(
            (e) => e.type === 'directory' && (e.path === r.key || e.path.startsWith(`${r.key}/`))
          )
          .sort((a, b) => b.path.length - a.path.length)) {
          if (
            r.key === 'worktree' &&
            r.git &&
            r.head &&
            (entry.path === `${r.key}/.git` || entry.path.startsWith(`${r.key}/.git/`))
          )
            continue
          jailedFs.setDirectoryMode(
            judgePath(join(base, entry.path), opts.roots(), { access: 'entry', subtree: true }),
            entry.mode
          )
        }
        await save(id, record)
      }
      record.activated = paths
      await save(id, record)
      return paths
    },
    async discard(id: string) {
      await rm(directory(id), { recursive: true, force: true })
      records.delete(id)
    }
  }
  // A hub request can time out while its native work continues. Serialize by move
  // so a retry cannot remove a snapshot that the first request is still building.
  const pending = new Map<string, Promise<unknown>>()
  const serial = <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const next = (pending.get(id) ?? Promise.resolve()).catch(() => undefined).then(work)
    pending.set(id, next)
    const clear = () => {
      if (pending.get(id) === next) pending.delete(id)
    }
    void next.then(clear, clear)
    return next
  }
  return {
    snapshot: (input: Parameters<typeof api.snapshot>[0]) =>
      serial(input.id, () => api.snapshot(input)),
    begin: (input: Parameters<typeof api.begin>[0]) => serial(input.id, () => api.begin(input)),
    offset: (id: string, path: string) => serial(id, () => api.offset(id, path)),
    read: (id: string, path: string, offset: number, length: number) =>
      serial(id, () => api.read(id, path, offset, length)),
    write: (id: string, path: string, offset: number, data: string) =>
      serial(id, () => api.write(id, path, offset, data)),
    verify: (id: string) => serial(id, () => api.verify(id)),
    verifySource: (id: string) => serial(id, () => api.verifySource(id)),
    verifyDestination: (id: string) => serial(id, () => api.verifyDestination(id)),
    activate: (id: string, project: string) => serial(id, () => api.activate(id, project)),
    discard: (id: string) => serial(id, () => api.discard(id))
  }
}
