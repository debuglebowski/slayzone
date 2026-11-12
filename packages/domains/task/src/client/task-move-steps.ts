import type { ImportTaskMoveInput, TaskMoveBundle } from '@slayzone/task-contracts'
import type { TaskMoveStepRunner, TaskMoveWorkStep } from './task-move-engine'
import {
  copyMovedSessions,
  type SessionsSourceApi,
  type SessionsTargetApi
} from '../shared/copy-sessions'

/** One artifact file a move copies (`artifacts.move*`): a version blob or a working copy. */
export type TaskMoveFileRef =
  | { kind: 'blob'; hash: string }
  | { kind: 'file'; taskId: string; path: string }
export interface TaskMoveFileEntry {
  ref: TaskMoveFileRef
  size: number
  hash: string
}

/** The hub the tasks leave. */
/** One hub's side of a blocker a move splits between two hubs. */
export interface TaskMoveRemoteBlockerLink {
  taskId: string
  role: 'blocks' | 'blocked_by'
  remoteHubId: string
  remoteTaskId: string
  remoteTitle: string | null
}

export interface TaskMoveSourceApi extends SessionsSourceApi {
  exportBundle(moveId: string): Promise<TaskMoveBundle>
  addRemoteBlockers(moveId: string, links: TaskMoveRemoteBlockerLink[]): Promise<void>
  fileManifest(moveId: string): Promise<TaskMoveFileEntry[]>
  readFile(
    moveId: string,
    ref: TaskMoveFileRef,
    offset: number,
    length: number
  ): Promise<{ data: string; eof: boolean }>
}

/** The hub the tasks go to. */
export interface TaskMoveTargetApi extends SessionsTargetApi {
  importBundle(input: ImportTaskMoveInput): Promise<void>
  addRemoteBlockers(moveId: string, links: TaskMoveRemoteBlockerLink[]): Promise<void>
  missingFiles(
    moveId: string,
    entries: TaskMoveFileEntry[]
  ): Promise<Array<TaskMoveFileEntry & { offset: number }>>
  writeFile(input: {
    moveId: string
    ref: TaskMoveFileRef
    offset: number
    data: string
    complete?: { size: number; hash: string }
  }): Promise<void>
  clearStaging(moveId: string): Promise<void>
  commit(moveId: string): Promise<void>
}

/** Bytes per chunk the app relays from one hub to the other. */
export const TASK_MOVE_CHUNK_BYTES = 512 * 1024

/**
 * The work of each step of a move between hubs, for {@link runTaskMove}. Each is
 * safe to run again: `export` is a read, `import` and `commit` are idempotent on the
 * target. The bundle read by `export` is kept for `import`; after a resume (another
 * run, another device) `import` reads it again.
 */
export function createTaskMoveSteps(opts: {
  /** The source hub's id in the app's registry: the target records where tasks came from. */
  sourceHubId: string
  source: TaskMoveSourceApi
  target: TaskMoveTargetApi
}): Record<TaskMoveWorkStep, TaskMoveStepRunner> {
  const bundles = new Map<string, TaskMoveBundle>()
  const bundleOf = async (moveId: string): Promise<TaskMoveBundle> => {
    const known = bundles.get(moveId)
    if (known) return known
    const bundle = await opts.source.exportBundle(moveId)
    bundles.set(moveId, bundle)
    return bundle
  }
  return {
    export: async ({ move }) => {
      await bundleOf(move.id)
    },
    import: async ({ move }) => {
      await opts.target.importBundle({
        sourceHubId: opts.sourceHubId,
        targetProjectId: move.targetProjectId,
        includeSessions: move.includeSessions,
        bundle: await bundleOf(move.id)
      })
    },
    // Every file the target lacks, chunk by chunk from where its copy stands; progress
    // in bytes over everything still to copy.
    'copy-files': async ({ move, reportProgress }) => {
      const manifest = await opts.source.fileManifest(move.id)
      const missing = await opts.target.missingFiles(move.id, manifest)
      const total = missing.reduce((n, f) => n + f.size, 0)
      let done = missing.reduce((n, f) => n + f.offset, 0)
      await reportProgress(done, total)
      for (const file of missing) {
        let offset = file.offset
        for (;;) {
          const chunk = await opts.source.readFile(move.id, file.ref, offset, TASK_MOVE_CHUNK_BYTES)
          const bytes =
            Math.ceil((chunk.data.length * 3) / 4) - (chunk.data.match(/=*$/)?.[0].length ?? 0)
          await opts.target.writeFile({
            moveId: move.id,
            ref: file.ref,
            offset,
            data: chunk.data,
            ...(chunk.eof ? { complete: { size: file.size, hash: file.hash } } : {})
          })
          offset += bytes
          done += bytes
          await reportProgress(done, total)
          if (chunk.eof) break
        }
      }
      await opts.target.clearStaging(move.id)
    },
    // The tasks' agent sessions: chats, files beside them, ledger, ownership (copy-sessions.ts).
    'copy-sessions': async ({ move, reportProgress }) => {
      if (!move.includeSessions) return
      await copyMovedSessions({
        move,
        source: opts.source,
        target: opts.target,
        reportProgress
      })
    },
    // A blocker between a moved task and one staying behind: each hub keeps its side.
    links: async ({ move }) => {
      const bundle = await bundleOf(move.id)
      if (bundle.externalDependencies.length === 0) return
      const titles = new Map(
        (bundle.rows.tasks ?? []).map((t) => [t.id as string, (t.title as string) ?? null])
      )
      const onTarget: TaskMoveRemoteBlockerLink[] = []
      const onSource: TaskMoveRemoteBlockerLink[] = []
      for (const d of bundle.externalDependencies) {
        // `task_id` blocks `blocks_task_id`; one of them moved.
        const movedBlocks = titles.has(d.task_id)
        const moved = movedBlocks ? d.task_id : d.blocks_task_id
        const staying = movedBlocks ? d.blocks_task_id : d.task_id
        onTarget.push({
          taskId: moved,
          role: movedBlocks ? 'blocks' : 'blocked_by',
          remoteHubId: opts.sourceHubId,
          remoteTaskId: staying,
          remoteTitle: d.staying_title || null
        })
        onSource.push({
          taskId: staying,
          role: movedBlocks ? 'blocked_by' : 'blocks',
          remoteHubId: move.peerHubId,
          remoteTaskId: moved,
          remoteTitle: titles.get(moved) ?? null
        })
      }
      await opts.target.addRemoteBlockers(move.id, onTarget)
      await opts.source.addRemoteBlockers(move.id, onSource)
    },
    commit: async ({ move }) => {
      await opts.target.commit(move.id)
      bundles.delete(move.id)
    }
  }
}
