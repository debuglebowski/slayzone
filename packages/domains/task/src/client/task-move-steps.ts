import type { ImportTaskMoveInput, TaskMoveBundle } from '@slayzone/task-contracts'
import type { TaskMoveStepRunner, TaskMoveWorkStep } from './task-move-engine'

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
export interface TaskMoveSourceApi {
  exportBundle(moveId: string): Promise<TaskMoveBundle>
  fileManifest(moveId: string): Promise<TaskMoveFileEntry[]>
  readFile(
    moveId: string,
    ref: TaskMoveFileRef,
    offset: number,
    length: number
  ): Promise<{ data: string; eof: boolean }>
}

/** The hub the tasks go to. */
export interface TaskMoveTargetApi {
  importBundle(input: ImportTaskMoveInput): Promise<void>
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
    // Cross-hub blocker links (slice 3d).
    links: () => Promise.resolve(),
    commit: async ({ move }) => {
      await opts.target.commit(move.id)
      bundles.delete(move.id)
    }
  }
}
