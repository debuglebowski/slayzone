import type { ImportTaskMoveInput, TaskMoveBundle } from '@slayzone/task-contracts'
import type { TaskMoveStepRunner, TaskMoveWorkStep } from './task-move-engine'

/** The hub the tasks leave. */
export interface TaskMoveSourceApi {
  exportBundle(moveId: string): Promise<TaskMoveBundle>
}

/** The hub the tasks go to. */
export interface TaskMoveTargetApi {
  importBundle(input: ImportTaskMoveInput): Promise<void>
  commit(moveId: string): Promise<void>
}

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
    // Artifact bytes (slice 3c) and cross-hub blocker links (slice 3d).
    'copy-files': () => Promise.resolve(),
    links: () => Promise.resolve(),
    commit: async ({ move }) => {
      await opts.target.commit(move.id)
      bundles.delete(move.id)
    }
  }
}
