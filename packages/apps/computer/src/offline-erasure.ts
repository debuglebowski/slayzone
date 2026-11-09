import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  readdirSync,
  openSync,
  fsyncSync,
  closeSync
} from 'node:fs'
import { join, dirname } from 'node:path'
import { z } from 'zod'
import { createComputerChatRuntime } from '@slayzone/chat-runtime/server'
import { createFileCredentialStore, hubHostFromUrl } from '@slayzone/computer-transport/client'
import { assertPathSafeId, containedPath } from '@slayzone/platform/safe-path'

const requestSchema = z.object({
  version: z.literal(1),
  requestId: z.uuid(),
  jobId: z.uuid(),
  computerId: z.string().min(1),
  hubUrl: z.url(),
  hubScope: z.string().min(1),
  tasks: z
    .array(z.object({ taskId: z.string().min(1), revision: z.number().int().positive() }))
    .min(1),
  worktreeTaskIds: z.array(z.string())
})
function alive(pid: number, processGroup = false): boolean {
  if (!Number.isSafeInteger(pid) || pid < (processGroup ? 2 : 1))
    throw new Error('Invalid computer process identity')
  try {
    // A detached group's children may survive after its leader exits. Probe the
    // whole POSIX group before issuing evidence that no writer remains.
    process.kill(processGroup && process.platform !== 'win32' ? -pid : pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
function sync(path: string) {
  if (process.platform === 'win32' || !existsSync(path)) return
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
/** Runs on the named computer with its host stopped; no hub connection or credential revival. */
export async function eraseComputerOffline(
  root: string,
  raw: unknown,
  options: { worktreesVerified?: boolean } = {}
) {
  const request = requestSchema.parse(raw),
    runtime = join(root, 'computer-runtime')
  if (hubHostFromUrl(request.hubUrl) !== request.hubScope)
    throw new Error('Hub namespace does not match the cleanup request')
  const credential = await createFileCredentialStore(request.hubScope, { baseDir: root }).load()
  if (credential?.computerId !== request.computerId)
    throw new Error('Computer identity does not match this cleanup request')
  const host = join(runtime, 'host.json')
  if (existsSync(host) && alive(JSON.parse(readFileSync(host, 'utf8')).pid))
    throw new Error('Stop the computer host before offline cleanup')
  const groups = join(runtime, 'proc-groups.json')
  if (existsSync(groups))
    for (const group of JSON.parse(readFileSync(groups, 'utf8')).groups ?? [])
      if (alive(group.pgid, true))
        throw new Error('A computer process is still running. Stop it before offline cleanup.')
  if (request.worktreeTaskIds.length && !options.worktreesVerified)
    throw new Error(
      'Verify removal of the listed task worktrees locally, then repeat with --worktrees-verified. Git repositories and shared worktrees must be kept.'
    )
  const namespace = createHash('sha256').update(JSON.stringify(request.hubScope)).digest('hex')
  if (!existsSync(join(runtime, namespace, 'chat.sqlite')))
    throw new Error(
      'This hub’s existing chat store was not found; no cleanup receipt can be issued'
    )
  const r = createComputerChatRuntime({
    stateDir: root,
    hubScope: request.hubScope,
    computerId: request.computerId,
    maintenance: true
  })
  try {
    // The original host and process groups are verified stopped above. Its old
    // ephemeral backup leases have no surviving writer; do not wait out a TTL.
    r.storage.compose((raw) =>
      raw.exec('DELETE FROM blob_leases; DELETE FROM artifact_blob_leases;')
    )
    for (const task of request.tasks) {
      assertPathSafeId(task.taskId, 'taskId')
      await r.eraseTask(task.taskId, task.revision)
      const historyRoot = join(
        runtime,
        'pty-history',
        createHash('sha256').update(request.hubScope).digest('hex')
      )
      const history = containedPath(historyRoot, task.taskId)
      rmSync(history, { recursive: true, force: true })
      if (existsSync(history)) throw new Error('Terminal history remains')
      sync(historyRoot)
    }
  } finally {
    await r.close()
  }
  const journal = join(
    runtime,
    'hooks-' + createHash('sha256').update(request.hubUrl).digest('hex').slice(0, 16) + '.json'
  )
  const ids = new Set(request.tasks.map((t) => t.taskId))
  if (existsSync(journal)) {
    const entries = z
      .array(z.object({ id: z.string(), params: z.unknown() }))
      .parse(JSON.parse(readFileSync(journal, 'utf8')))
    const remaining = entries.filter((entry) => {
      const params = entry.params as { payload?: { taskId?: string } } | null
      return !params?.payload?.taskId || !ids.has(params.payload.taskId)
    })
    const temp = journal + '.' + randomUUID() + '.tmp'
    writeFileSync(temp, JSON.stringify(remaining), { flag: 'wx', mode: 0o600 })
    sync(temp)
    renameSync(temp, journal)
    sync(runtime)
  }
  // Unpublished journal staging is already discarded on normal host startup.
  for (const entry of readdirSync(runtime))
    if (entry.startsWith(journal.slice(dirname(journal).length + 1) + '.')) {
      const match = /\.(\d+)\.[a-f0-9]{8}\.tmp$/.exec(entry)
      if (match) {
        if (alive(Number(match[1]))) throw new Error('A hook journal writer is still running')
        rmSync(join(runtime, entry))
        sync(runtime)
      }
    }
  return {
    request,
    verifiedAt: new Date().toISOString(),
    managedContentErased: true as const,
    worktreesVerified: request.worktreeTaskIds.length === 0 || options.worktreesVerified === true
  }
}
