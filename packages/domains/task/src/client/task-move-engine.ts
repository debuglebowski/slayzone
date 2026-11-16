import type { TaskMove, TaskMoveStep } from '@slayzone/task-contracts'

/**
 * Runs a move to another hub, step by step (`TASK_MOVE_STEPS`), against the journal
 * on the hub the tasks leave. The app is the only party connected to both hubs, so
 * it runs the steps; the journal records each one, so the move survives a closed app
 * or a dropped hub.
 *
 * ONE code path for every start: a fresh move, a resume after pause, and recovery
 * after a crash all call {@link runTaskMove} with the move's id, and it continues
 * from the step the journal names. Every step must be safe to run again — a crash
 * can land between a step's work and its journal entry.
 *
 * Pause takes effect between steps: the running step finishes, then the move is
 * recorded as paused (its tasks stay locked).
 */

/** `lock` is done by the move's begin: the engine only records it. */
const recordOnly: TaskMoveStepRunner = () => Promise.resolve()

/** The source hub's journal (`taskMoves.*`). */
export interface TaskMoveJournal {
  get(id: string): Promise<TaskMove>
  advance(id: string, completed: TaskMoveStep): Promise<TaskMove>
  progress(id: string, step: TaskMoveStep, done: number, total: number): Promise<TaskMove>
  pause(id: string): Promise<TaskMove>
  fail(id: string, error: string): Promise<TaskMove>
  release(id: string): Promise<TaskMove>
}

export interface TaskMoveStepContext {
  move: TaskMove
  /** How far the step got (bytes copied, rows written): recorded in the journal. */
  reportProgress(done: number, total: number): Promise<void>
}
export type TaskMoveStepRunner = (ctx: TaskMoveStepContext) => Promise<void>

/** The work between locking (the move's begin) and releasing (the journal's own). */
export type TaskMoveWorkStep = Exclude<TaskMoveStep, 'lock' | 'release'>

export interface RunTaskMoveOptions {
  journal: TaskMoveJournal
  steps: Record<TaskMoveWorkStep, TaskMoveStepRunner>
  /** Asked between steps: true = record the move as paused and stop. */
  pauseRequested: () => boolean
  /** Every journal answer, for progress UI. */
  onUpdate?: (move: TaskMove) => void
}

/**
 * Run move `id` from where its journal stands until it is done, paused or failed.
 * A move that is not running (paused, failed, canceled, done) is answered as it is:
 * resuming one is the journal's `resume`, then this.
 */
export async function runTaskMove(id: string, opts: RunTaskMoveOptions): Promise<TaskMove> {
  const { journal, steps, pauseRequested } = opts
  const seen = (move: TaskMove): TaskMove => {
    opts.onUpdate?.(move)
    return move
  }
  let move = seen(await journal.get(id))
  while (move.status === 'running') {
    if (move.step === 'release') return seen(await journal.release(id))
    if (pauseRequested()) return seen(await journal.pause(id))
    const step = move.step
    // `lock` is done by the move's begin; a journal still there (a crash in
    // between) only has to record it.
    const runner = step === 'lock' ? null : steps[step]
    const ok = await (runner ?? recordOnly)({
      move,
      reportProgress: async (done, total) => {
        move = seen(await journal.progress(id, step, done, total))
      }
    }).then(
      () => true,
      async (error: unknown) => {
        move = seen(await journal.fail(id, error instanceof Error ? error.message : String(error)))
        return false
      }
    )
    if (!ok) return move
    move = seen(await journal.advance(id, step))
  }
  return move
}
