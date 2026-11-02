/** Portable Git observation: runs on the machine owning the workspace, never changes its index. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { childProcessEnv } from '@slayzone/platform'
import type {
  WorkspaceCaptureBegin,
  WorkspaceCaptureRequest,
  WorkspaceCaptureResult,
  WorkspaceFileDiff
} from '@slayzone/terminal-contracts'

const PREFIX = 'refs/slayzone/workspace-captures/'
const FILE_LIMIT = 1024 * 1024
const TURN_LIMIT = 4 * FILE_LIMIT
const unavailable = (reason: string): WorkspaceCaptureResult => ({
  status: 'unavailable',
  reason,
  files: []
})

/** A workspace-scoped operation must not inherit Git environment redirects from its host. */
// Typed `NodeJS.ProcessEnv` (what spawn options take), not `Record<string, string>`:
// a program whose types make some env key required (Expo's `NODE_ENV`) rejects the latter.
export function workspaceGitEnv(overlay: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = childProcessEnv()
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key]
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_COMMON_DIR',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES'
  ])
    delete env[key]
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'SlayZone',
    GIT_AUTHOR_EMAIL: 'snapshot@slayzone.local',
    GIT_COMMITTER_NAME: 'SlayZone',
    GIT_COMMITTER_EMAIL: 'snapshot@slayzone.local',
    ...overlay
  }
}

function refs(request: WorkspaceCaptureRequest): string {
  if (!/^[a-zA-Z0-9-]{1,200}$/.test(request.id)) throw new Error('Invalid capture ID')
  const scope = createHash('sha256').update(request.scope).digest('hex')
  return `${PREFIX}${scope}/${request.id}`
}

/** One deadline spans ALL Git invocations in a capture, including snapshot construction. */
function runner(rootPath: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  return async (
    args: string[],
    env: Record<string, string> = {},
    maxBuffer = TURN_LIMIT
  ): Promise<{ text: string; truncated: boolean }> => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Workspace capture timed out')
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-c', 'core.fsmonitor=false', ...args],
        {
          cwd: rootPath,
          env: workspaceGitEnv(env),
          encoding: 'utf8',
          timeout: remaining,
          killSignal: 'SIGKILL',
          maxBuffer
        },
        (err, stdout) => {
          if (err && 'code' in err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            resolve({ text: stdout, truncated: true })
          } else if (err) reject(err)
          else resolve({ text: stdout, truncated: false })
        }
      )
    })
  }
}
type Git = ReturnType<typeof runner>

async function resolveRef(git: Git, ref: string): Promise<string | null> {
  try {
    return (await git(['rev-parse', '--verify', ref])).text.trim() || null
  } catch {
    return null
  }
}

async function snapshot(git: Git, ref: string): Promise<string> {
  const existing = await resolveRef(git, ref)
  if (existing) return existing
  const head = await resolveRef(git, 'HEAD')
  const tree = await writeWorkspaceTree(git, head)
  const sha = (
    await git([
      'commit-tree',
      tree,
      ...(head ? ['-p', head] : []),
      '-m',
      'SlayZone workspace observation'
    ])
  ).text.trim()
  // A retry racing the original request must keep the FIRST baseline.
  try {
    await git(['update-ref', ref, sha, '0'.repeat(sha.length)])
  } catch {
    const first = await resolveRef(git, ref)
    if (first) return first
    throw new Error('Could not pin workspace snapshot')
  }
  return sha
}

/** Shared by legacy turn snapshots and chat observations; the user's index is never selected. */
export async function writeWorkspaceTree(git: Git, head: string | null): Promise<string> {
  const temp = await mkdtemp(join(tmpdir(), 'slayzone-workspace-'))
  try {
    const env = { GIT_INDEX_FILE: join(temp, 'index') }
    await git(['read-tree', ...(head ? [head] : ['--empty'])], env)
    await git(['add', '-A'], env)
    const tree = (await git(['write-tree'], env)).text.trim()
    if (!tree) throw new Error('Could not write workspace tree')
    return tree
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

function changedFiles(text: string): WorkspaceFileDiff[] {
  const parts = text.split('\0')
  const result: WorkspaceFileDiff[] = []
  for (let i = 0; parts[i]; ) {
    const status = parts[i++]
    const first = parts[i++]
    const renamed = status.startsWith('R')
    const path = renamed ? parts[i++] : first
    if (!path) throw new Error('Incomplete workspace file listing')
    result.push({
      path,
      ...(renamed ? { oldPath: first } : {}),
      kind: renamed
        ? 'renamed'
        : status === 'A'
          ? 'added'
          : status === 'D'
            ? 'deleted'
            : 'modified',
      additions: null,
      deletions: null,
      binary: false,
      diff: null
    })
  }
  return result
}

function applyCounts(text: string, files: WorkspaceFileDiff[]): void {
  const byPath = new Map(files.map((f) => [f.path, f]))
  const parts = text.split('\0')
  for (let i = 0; parts[i]; ) {
    const entry = parts[i++]
    const first = entry.indexOf('\t'),
      second = entry.indexOf('\t', first + 1)
    const adds = entry.slice(0, first),
      dels = entry.slice(first + 1, second)
    let path = entry.slice(second + 1)
    if (!path) {
      i++
      path = parts[i++]
    }
    const file = byPath.get(path)
    if (!file) continue
    file.binary = adds === '-' || dels === '-'
    file.additions = file.binary ? null : Number(adds)
    file.deletions = file.binary ? null : Number(dels)
  }
}

export class WorkspaceSnapshotManager {
  private readonly cleanupAt = new Map<string, number>()
  constructor(private readonly timeoutMs = 5000) {}

  async begin(request: WorkspaceCaptureRequest): Promise<WorkspaceCaptureBegin> {
    try {
      const git = runner(request.rootPath, this.timeoutMs)
      await this.prune(request.rootPath, git)
      await snapshot(git, `${refs(request)}/before`)
      return { status: 'ready' }
    } catch {
      return {
        status: 'unavailable',
        reason: 'Workspace baseline unavailable (not a Git repository, inaccessible, or timed out).'
      }
    }
  }

  async finish(request: WorkspaceCaptureRequest): Promise<WorkspaceCaptureResult> {
    let files: WorkspaceFileDiff[] = []
    try {
      const git = runner(request.rootPath, this.timeoutMs)
      const ref = refs(request)
      const before = await resolveRef(git, `${ref}/before`)
      if (!before) return unavailable('Workspace baseline unavailable.')
      const after = await snapshot(git, `${ref}/after`)
      const args = ['--no-ext-diff', '--no-textconv', '--no-color', '-M', before, after]
      const names = await git(['diff', '--name-status', '-z', ...args])
      if (names.truncated) return unavailable('Workspace file listing exceeded capture limit.')
      files = changedFiles(names.text)
      if (!files.length) return { status: 'complete', files }
      const counts = await git(['diff', '--numstat', '-z', ...args])
      applyCounts(counts.text, files)
      const patch = await git(['diff', '--patch', '--src-prefix=a/', '--dst-prefix=b/', ...args])
      const blocks = patch.text.split(/(?=^diff --git )/m).filter(Boolean)
      if (patch.truncated) blocks.pop() // Last block is incomplete; never present a truncated diff as exact.
      let partial = counts.truncated || patch.truncated
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        if (file.binary) {
          file.omitted = 'binary'
          continue
        }
        const block = blocks[i]
        if (!block || Buffer.byteLength(block) > FILE_LIMIT) {
          file.omitted = 'size-limit'
          partial = true
        } else file.diff = block
      }
      return {
        status: partial ? 'partial' : 'complete',
        ...(partial ? { reason: 'Some text diffs exceeded capture limits.' } : {}),
        files
      }
    } catch {
      if (files.length)
        return {
          status: 'partial',
          reason: 'Workspace diff capture failed or timed out.',
          files: files.map((f) => ({ ...f, omitted: 'capture-failed' }))
        }
      return unavailable('Workspace capture failed or timed out.')
    }
  }

  async discard(request: WorkspaceCaptureRequest): Promise<void> {
    const git = runner(request.rootPath, this.timeoutMs)
    const ref = refs(request)
    await git(['update-ref', '-d', `${ref}/before`])
    await git(['update-ref', '-d', `${ref}/after`])
  }

  private async prune(rootPath: string, git: Git): Promise<void> {
    if (Date.now() - (this.cleanupAt.get(rootPath) ?? 0) < 3600_000) return
    const rows = await git(['for-each-ref', '--format=%(refname) %(committerdate:unix)', PREFIX])
    const cutoff = Date.now() / 1000 - 7 * 86400
    for (const line of rows.text.trim().split('\n')) {
      const space = line.lastIndexOf(' ')
      if (space > 0 && Number(line.slice(space + 1)) < cutoff)
        await git(['update-ref', '-d', line.slice(0, space)])
    }
    this.cleanupAt.set(rootPath, Date.now())
  }
}
