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
import { basename, join } from 'node:path'
import { z } from 'zod'
import { createComputerChatRuntime } from '@slayzone/chat-runtime/server'
import { createFileCredentialStore, hubHostFromUrl } from '@slayzone/computer-transport/client'
import { assertPathSafeId, containedPath } from '@slayzone/platform/safe-path'
import { HOOK_JOURNAL_FILE, hookJournalPath, legacyHookJournalPath } from './hook-journal'
import { ptyHistoryDir } from './pty-history'

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
/** An unpublished journal write (session-host.ts `atomicRuntimeJson`), any hub's. */
const HOOK_JOURNAL_STAGING = /^(hooks-[a-f0-9]{16}\.json)\.(\d+)\.[a-f0-9]{8}\.tmp$/
const journalSchema = z.array(z.object({ id: z.string(), params: z.unknown() }))
const taskOf = (params: unknown): string | undefined =>
  (params as { payload?: { taskId?: unknown } } | null)?.payload?.taskId as string | undefined

/** This hub's journal names: the one its URL names in any spelling (hook-journal.ts),
 *  and the one an older host named by the given spelling verbatim. */
const ownJournalNames = (runtime: string, hubUrl: string): Set<string> =>
  new Set(
    [hookJournalPath(runtime, hubUrl), legacyHookJournalPath(runtime, hubUrl)].map((path) =>
      basename(path)
    )
  )

/**
 * This hub's existing hook journals, checked before anything is deleted. Any OTHER
 * journal holding an event of a task being erased means the computer was configured
 * with a spelling neither name reaches (an older host that has not run since): refuse
 * instead of issuing a receipt over it. So must a journal write of this hub's still
 * running.
 */
function ownHookJournals(runtime: string, hubUrl: string, tasks: ReadonlySet<string>): string[] {
  const own = ownJournalNames(runtime, hubUrl)
  for (const entry of readdirSync(runtime)) {
    const staging = HOOK_JOURNAL_STAGING.exec(entry)
    if (staging && own.has(staging[1]) && alive(Number(staging[2])))
      throw new Error('A hook journal writer is still running')
    if (!HOOK_JOURNAL_FILE.test(entry) || own.has(entry)) continue
    const events = journalSchema.parse(JSON.parse(readFileSync(join(runtime, entry), 'utf8')))
    if (events.some((event) => tasks.has(taskOf(event.params) ?? '')))
      throw new Error(
        'Agent hook events of these tasks are kept under another spelling of the hub URL. ' +
          'Repeat with --computer-hub-url exactly as this computer is configured (its hubUrl); nothing was deleted.'
      )
  }
  return [...own].map((name) => join(runtime, name)).filter((path) => existsSync(path))
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
  const ids = new Set(request.tasks.map((t) => t.taskId))
  const journals = ownHookJournals(runtime, request.hubUrl, ids)
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
      // Where the live computer keeps it (main.ts): the same helper, so never another dir.
      const historyRoot = ptyHistoryDir(root, request.hubScope)
      const history = containedPath(historyRoot, task.taskId)
      // The task's whole dir: its sessions' files and any write a crash left
      // (pty-history.ts `<file>.<pid>.<n>.tmp`).
      rmSync(history, { recursive: true, force: true })
      if (existsSync(history)) throw new Error('Terminal history remains')
      sync(historyRoot)
    }
  } finally {
    await r.close()
  }
  for (const journal of journals) {
    const remaining = journalSchema
      .parse(JSON.parse(readFileSync(journal, 'utf8')))
      .filter((entry) => !ids.has(taskOf(entry.params) ?? ''))
    const temp = journal + '.' + randomUUID() + '.tmp'
    writeFileSync(temp, JSON.stringify(remaining), { flag: 'wx', mode: 0o600 })
    sync(temp)
    renameSync(temp, journal)
    sync(runtime)
  }
  // Unpublished journal writes (any hub's) whose writer is gone: discarded, as the
  // host's own startup does (session-host.ts `scrubChatJournals`).
  for (const entry of readdirSync(runtime)) {
    const staging = HOOK_JOURNAL_STAGING.exec(entry)
    if (!staging || alive(Number(staging[2]))) continue
    rmSync(join(runtime, entry))
    sync(runtime)
  }
  return {
    request,
    verifiedAt: new Date().toISOString(),
    managedContentErased: true as const,
    worktreesVerified: request.worktreeTaskIds.length === 0 || options.worktreesVerified === true
  }
}
