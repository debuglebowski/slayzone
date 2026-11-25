import { randomUUID } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import type {
  ComputerMove,
  ComputerMoveAgent,
  ComputerMoveDestination,
  ComputerMovePreview
} from '@slayzone/task-contracts'
import type {} from './task-txns'

/** Computer I/O stays on the host; the task domain owns ordering and commit. */
export interface ComputerMoveHost {
  resolve(taskId: string): Promise<string | null>
  destination(taskId: string, binding: string | null): Promise<string | null>
  inspect(
    taskId: string,
    source: string,
    target: string
  ): Promise<{
    ready: boolean
    blockers: string[]
    agents: ComputerMoveAgent[]
    hasRunningWork?: boolean
    hasStoredSessions?: boolean
    participants?: string[]
    destination?: ComputerMoveDestination | null
  }>
  /** Clone the task's repository into the project's folder on `target`, from the
   *  source computer's `origin`. */
  cloneRepository(taskId: string, source: string, target: string): Promise<void>
  stop(move: ComputerMove): Promise<void>
  copyWorkspace(
    move: ComputerMove,
    progress: (done: number, total: number) => Promise<void>
  ): Promise<void>
  copySessions(move: ComputerMove): Promise<ComputerMove['chats']>
  verifySource(move: ComputerMove): Promise<void>
  activate(move: ComputerMove): Promise<void>
  cancel(move: ComputerMove): Promise<void>
  finish(move: ComputerMove): Promise<void>
  changed(taskId: string): void
}

export function createComputerMoves(db: SlayzoneDb, host: ComputerMoveHost) {
  const inflight = new Map<string, Promise<ComputerMove>>()
  const get = async (taskId: string): Promise<ComputerMove | null> => {
    const row = await db.get<{ value: string }>(
      'SELECT value FROM task_computer_moves WHERE task_id=? ORDER BY updated_at DESC, rowid DESC LIMIT 1',
      [taskId]
    )
    return row ? JSON.parse(row.value) : null
  }
  const save = async (move: ComputerMove) => {
    await db.run('UPDATE task_computer_moves SET status=?, value=?, updated_at=? WHERE id=?', [
      move.status,
      JSON.stringify(move),
      Date.now(),
      move.id
    ])
  }
  const preview = async (taskId: string, binding: string | null): Promise<ComputerMovePreview> => {
    const row = await db.get<{
      has_worktree: number
      has_base_dir: number
      deleted_at: string | null
      archived_at: string | null
    }>('SELECT has_worktree,has_base_dir,deleted_at,archived_at FROM tasks WHERE id=?', [taskId])
    if (!row || row.deleted_at || row.archived_at)
      throw new Error('Open an active task before moving it to another computer.')
    const destinationComputerId = await host.destination(taskId, binding)
    const sourceComputerId =
      (await host.resolve(taskId)) ??
      (!(row.has_worktree || row.has_base_dir) ? destinationComputerId : null)
    if (!sourceComputerId || !destinationComputerId)
      throw new Error('Choose a connected computer for this task.')
    const inspected = await host.inspect(taskId, sourceComputerId, destinationComputerId)
    const hasFiles = !!(row.has_worktree || row.has_base_dir)
    return {
      sourceComputerId,
      destinationComputerId,
      ...inspected,
      hasFiles,
      requiresMigration:
        (sourceComputerId !== destinationComputerId ||
          inspected.participants?.some((id) => id !== destinationComputerId) === true) &&
        (hasFiles ||
          inspected.agents.length > 0 ||
          inspected.hasRunningWork === true ||
          inspected.hasStoredSessions === true)
    }
  }
  const api = {
    get,
    preview,
    /** Put the task's repository on the computer the task would move to. */
    async cloneRepository(taskId: string, binding: string | null): Promise<ComputerMovePreview> {
      const before = await preview(taskId, binding)
      const url = before.destination?.cloneUrl
      if (!url) throw new Error('The source repository has no remote to clone from.')
      await host.cloneRepository(taskId, before.sourceComputerId, before.destinationComputerId)
      return preview(taskId, binding)
    },
    async begin(input: {
      taskId: string
      computerId: string | null
      allowFreshSessions: boolean
    }): Promise<ComputerMove> {
      const current = await get(input.taskId)
      if (current && ['running', 'failed'].includes(current.status)) {
        if (
          current.binding === input.computerId &&
          current.allowFreshSessions === input.allowFreshSessions
        )
          return current
        throw new Error('This task already has a computer move. Retry or cancel it first.')
      }
      const before = await db.get<{
        project_id: string
        computer_id: string | null
        worktree_computer_id: string | null
        has_worktree: number
        has_base_dir: number
        default_computer_id: string | null
        repo_name: string | null
      }>(
        'SELECT t.project_id,t.computer_id,t.worktree_computer_id,t.has_worktree,t.has_base_dir,p.default_computer_id,t.repo_name FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?',
        [input.taskId]
      )
      if (!before) throw new Error('Task no longer exists')
      const p = await preview(input.taskId, input.computerId)
      if (!p.ready) throw new Error(p.blockers.join('\n'))
      if (!p.requiresMigration && p.sourceComputerId === p.destinationComputerId)
        throw new Error('This task already runs on the selected computer.')
      const freshTabIds = p.agents.filter((a) => !a.canResume).map((a) => a.tabId)
      if (freshTabIds.length && !input.allowFreshSessions)
        throw new Error('Confirm that unsupported agent sessions may start fresh.')
      const row = await db.get<{ project_id: string }>('SELECT project_id FROM tasks WHERE id=?', [
        input.taskId
      ])
      if (!row) throw new Error('Task no longer exists')
      const move: ComputerMove = {
        id: randomUUID(),
        taskId: input.taskId,
        projectId: row.project_id,
        sourceComputerId: p.sourceComputerId,
        destinationComputerId: p.destinationComputerId,
        participants: p.participants ?? [...new Set([p.sourceComputerId, p.destinationComputerId])],
        binding: input.computerId,
        allowFreshSessions: input.allowFreshSessions,
        status: 'running',
        step: 'stop',
        bytesDone: 0,
        bytesTotal: 0,
        error: null,
        chats: [],
        freshTabIds,
        sourceState: {
          binding: before.computer_id,
          holder: before.worktree_computer_id,
          repoName: before.repo_name,
          hasWorktree: before.has_worktree,
          hasBaseDir: before.has_base_dir,
          projectDefault: before.default_computer_id
        }
      }
      try {
        await db.namedTxn('task:begin-computer-move', { move })
      } catch (error) {
        const winner = await get(input.taskId)
        if (
          winner &&
          ['running', 'failed'].includes(winner.status) &&
          winner.binding === input.computerId &&
          winner.allowFreshSessions === input.allowFreshSessions
        )
          return winner
        throw error
      }
      return move
    },
    run(taskId: string): Promise<ComputerMove> {
      const pending = inflight.get(taskId)
      if (pending) return pending
      const work = (async () => {
        const move = await get(taskId)
        if (!move) throw new Error('No computer move for this task')
        if (move.status === 'done' || move.status === 'canceled') return move
        move.status = 'running'
        move.error = null
        await save(move)
        try {
          const advance = async (next: ComputerMove['step']) => {
            move.step = next
            await save(move)
          }
          if (move.step === 'stop') {
            await host.stop(move)
            await advance('files')
          }
          if (move.step === 'files') {
            await host.copyWorkspace(move, async (done, total) => {
              move.bytesDone = done
              move.bytesTotal = total
              await save(move)
            })
            await advance('activate')
          }
          // Destination folders must exist before copying CLI transcripts, whose
          // resume paths are derived on that computer. Task routing stays on source.
          if (move.step === 'activate') {
            await host.activate(move)
            await advance('sessions')
          }
          if (move.step === 'sessions') {
            move.chats = await host.copySessions(move)
            await advance('verify')
          }
          if (move.step === 'verify') {
            await host.verifySource(move)
            await advance('commit')
          }
          if (move.step === 'commit') {
            await db.namedTxn('task:commit-computer-move', { move: { ...move, step: 'finish' } })
            move.step = 'finish'
          }
          if (move.step === 'finish') {
            await host.finish(move)
            move.status = 'done'
            await save(move)
            host.changed(taskId)
          }
        } catch (error) {
          // A worker can commit and lose its reply. The persisted checkpoint is
          // authoritative; never let an uncertain acknowledgement roll it back.
          const recorded = await get(taskId)
          if (recorded?.id === move.id && recorded.step === 'finish') move.step = 'finish'
          move.status = 'failed'
          move.error = error instanceof Error ? error.message : String(error)
          await save(move)
        }
        return move
      })().finally(() => inflight.delete(taskId))
      inflight.set(taskId, work)
      return work
    },
    async cancel(taskId: string): Promise<ComputerMove> {
      if (inflight.has(taskId))
        throw new Error('Wait for the current transfer step to stop before canceling.')
      const move = await get(taskId)
      if (!move) throw new Error('No computer move for this task')
      if (move.status === 'done' || move.status === 'canceled') return move
      if (move.step === 'finish')
        throw new Error('The destination already owns this task. Retry to finish the move.')
      await host.cancel(move)
      move.status = 'canceled'
      move.error = null
      await save(move)
      host.changed(taskId)
      return move
    }
  }
  return api
}

let moves: ReturnType<typeof createComputerMoves> | null = null
export function setComputerMoves(value: ReturnType<typeof createComputerMoves>) {
  moves = value
}
export function computerMoves() {
  if (!moves) throw new Error('Computer migration is not available on this hub')
  return moves
}
