import { create } from 'zustand'
import { createTaskMoveSteps, runTaskMove, type TaskMoveJournal } from '@slayzone/task/client'
import type { TaskMove } from '@slayzone/task-contracts'
import { useHubOwnershipStore } from '@slayzone/transport/client'
import { getClientForHub, type TasksTrpcClient } from './trpc'

/**
 * Moves of tasks to another hub, as this app runs and watches them (slice 3e). The
 * hub the tasks leave keeps each move's journal; this store mirrors the unfinished
 * moves of every hub the app knows, runs the ones this app started or resumed, and
 * answers which tasks are moving (the "Moving…" mark on cards and rows).
 *
 * One code path runs a move: {@link runTaskMove}, for a fresh start, a resume after
 * pause, and a move the app finds running at start (a crash or a quit in between).
 */

export interface TrackedMove {
  move: TaskMove
  /** The hub the tasks leave (whose journal this is). */
  sourceHubId: string
  /** This app is running the move's steps now. */
  running: boolean
  /** Pause asked: takes effect after the running step. */
  pauseRequested: boolean
}

interface TaskMovesState {
  moves: Record<string, TrackedMove>
}

export const useTaskMovesStore = create<TaskMovesState>(() => ({ moves: {} }))

const setMove = (id: string, patch: Partial<TrackedMove>): void =>
  useTaskMovesStore.setState((s) => {
    const prev = s.moves[id]
    if (!prev && !patch.move) return s
    return { moves: { ...s.moves, [id]: { ...(prev as TrackedMove), ...patch } } }
  })

const forget = (id: string): void =>
  useTaskMovesStore.setState((s) => {
    const { [id]: _gone, ...rest } = s.moves
    return { moves: rest }
  })

/** A running move whose journal has not moved for this long has nobody running it. */
const ORPHANED_AFTER_MS = 60_000

const UNFINISHED = new Set<TaskMove['status']>(['running', 'paused', 'failed'])

/** Whether `taskId` is in an unfinished move this app knows of. */
export function useIsTaskMoving(taskId: string | null | undefined): boolean {
  return useTaskMovesStore((s) =>
    taskId
      ? Object.values(s.moves).some(
          (m) => UNFINISHED.has(m.move.status) && m.move.taskIds.includes(taskId)
        )
      : false
  )
}

function journalOf(client: TasksTrpcClient): TaskMoveJournal {
  return {
    get: (id) => client.taskMoves.get.query({ id }),
    advance: (id, completed) => client.taskMoves.advance.mutate({ id, completed }),
    progress: (id, step, done, total) =>
      client.taskMoves.progress.mutate({ id, step, done, total }),
    pause: (id) => client.taskMoves.pause.mutate({ id }),
    fail: (id, error) => client.taskMoves.fail.mutate({ id, error }),
    release: (id) => client.taskMoves.release.mutate({ id })
  }
}

/** Run move `id` (journal on `sourceHubId`) to its end, pause or failure. */
async function drive(id: string, sourceHubId: string): Promise<void> {
  const tracked = useTaskMovesStore.getState().moves[id]
  if (tracked?.running) return
  const source = getClientForHub(sourceHubId) as unknown as TasksTrpcClient
  const first = await source.taskMoves.get.query({ id })
  const target = getClientForHub(first.peerHubId) as unknown as TasksTrpcClient
  setMove(id, { move: first, sourceHubId, running: true, pauseRequested: false })
  const done = await runTaskMove(id, {
    journal: journalOf(source),
    steps: createTaskMoveSteps({
      sourceHubId,
      source: {
        exportBundle: (moveId) => source.taskMoves.export.query({ id: moveId }),
        addRemoteBlockers: (moveId, links) =>
          source.taskMoves.addRemoteBlockers.mutate({ moveId, links }).then(() => undefined),
        fileManifest: (moveId) => source.artifacts.moveManifest.query({ moveId }),
        readFile: (moveId, ref, offset, length) =>
          source.artifacts.moveRead.query({ moveId, ref, offset, length }),
        sessionsExport: (moveId, taskId) =>
          source.taskMoves.sessionsExport.mutate({ moveId, taskId }),
        sessionsRead: (input) => source.taskMoves.sessionsRead.query(input),
        sessionsReadAttachment: (input) => source.taskMoves.sessionsReadAttachment.query(input),
        sessionsFiles: (moveId, taskId) => source.taskMoves.sessionsFiles.query({ moveId, taskId }),
        sessionsFileRead: (input) => source.taskMoves.sessionsFileRead.query(input),
        sessionsDiscard: (moveId) =>
          source.taskMoves.sessionsDiscard.mutate({ moveId }).then(() => undefined)
      },
      target: {
        importBundle: (input) => target.taskMoves.import.mutate(input).then(() => undefined),
        addRemoteBlockers: (moveId, links) =>
          target.taskMoves.addRemoteBlockers.mutate({ moveId, links }).then(() => undefined),
        missingFiles: (moveId, entries) => target.artifacts.moveMissing.mutate({ moveId, entries }),
        writeFile: (input) => target.artifacts.moveWrite.mutate(input).then(() => undefined),
        clearStaging: (moveId) =>
          target.artifacts.moveClearStaging.mutate({ moveId }).then(() => undefined),
        sessionsBegin: (moveId, taskId, manifest) =>
          target.taskMoves.sessionsBegin.mutate({ moveId, taskId, manifest }),
        sessionsChunk: (input) =>
          target.taskMoves.sessionsChunk.mutate(input).then(() => undefined),
        sessionsFinish: (moveId, taskId, transferId) =>
          target.taskMoves.sessionsFinish.mutate({ moveId, taskId, transferId }),
        sessionsPutAttachment: (input) =>
          target.taskMoves.sessionsPutAttachment.mutate(input).then(() => undefined),
        sessionsActivate: (input) =>
          target.taskMoves.sessionsActivate.mutate(input).then(() => undefined),
        sessionsFilesMissing: (moveId, taskId, entries) =>
          target.taskMoves.sessionsFilesMissing.mutate({ moveId, taskId, entries }),
        sessionsFileWrite: (input) =>
          target.taskMoves.sessionsFileWrite.mutate(input).then(() => undefined),
        sessionsImportLedger: (moveId, taskId, ledger) =>
          target.taskMoves.sessionsImportLedger
            .mutate({ moveId, taskId, ledger })
            .then(() => undefined),
        sessionsRegister: (moveId, taskId, chats) =>
          target.taskMoves.sessionsRegister.mutate({ moveId, taskId, chats }).then(() => undefined),
        commit: (moveId) => target.taskMoves.commit.mutate({ id: moveId }).then(() => undefined)
      }
    }),
    pauseRequested: () => useTaskMovesStore.getState().moves[id]?.pauseRequested ?? false,
    onUpdate: (move) => setMove(id, { move })
  }).catch(async (error: unknown) => {
    // A call that failed outside a step (a hub went away mid-journal): recorded as
    // failed when the source still answers, else left for the next resume.
    const message = error instanceof Error ? error.message : String(error)
    return source.taskMoves.fail.mutate({ id, error: message }).catch(() => ({
      ...first,
      status: 'failed' as const,
      error: message
    }))
  })
  setMove(id, { move: done, running: false })
  if (done.status === 'done') {
    // The tasks are the target hub's: every open tab and link resolves there now.
    const { noteTaskHub } = useHubOwnershipStore.getState()
    for (const taskId of done.taskIds) noteTaskHub(taskId, done.peerHubId)
    forget(id)
  }
}

/** Begin moving `taskIds` to `targetProjectId` on `targetHubId`, and run it. */
export async function startCrossHubMove(input: {
  sourceHubId: string
  targetHubId: string
  targetProjectId: string
  taskIds: string[]
  includeSubtasks: boolean
  includeSessions?: boolean
}): Promise<TaskMove> {
  const source = getClientForHub(input.sourceHubId) as unknown as TasksTrpcClient
  const move = await source.taskMoves.begin.mutate({
    id: crypto.randomUUID(),
    taskIds: input.taskIds,
    targetHubId: input.targetHubId,
    targetProjectId: input.targetProjectId,
    includeSubtasks: input.includeSubtasks,
    includeSessions: input.includeSessions ?? true
  })
  setMove(move.id, { move, sourceHubId: input.sourceHubId, running: false, pauseRequested: false })
  void drive(move.id, input.sourceHubId)
  return move
}

/** Pause after the running step (its tasks stay locked). */
export async function pauseCrossHubMove(id: string): Promise<void> {
  const tracked = useTaskMovesStore.getState().moves[id]
  if (!tracked) return
  if (tracked.running) {
    setMove(id, { pauseRequested: true })
    return
  }
  const client = getClientForHub(tracked.sourceHubId) as unknown as TasksTrpcClient
  setMove(id, { move: await client.taskMoves.pause.mutate({ id }) })
}

/** Resume a paused or failed move from the step it stopped at. */
export async function resumeCrossHubMove(id: string): Promise<void> {
  const tracked = useTaskMovesStore.getState().moves[id]
  if (!tracked || tracked.running) return
  const client = getClientForHub(tracked.sourceHubId) as unknown as TasksTrpcClient
  setMove(id, { move: await client.taskMoves.resume.mutate({ id }) })
  await drive(id, tracked.sourceHubId)
}

/**
 * Give up a move the target has not taken yet: the target drops what it imported,
 * the source lifts the lock. Refused by the hub once the target committed.
 */
export async function cancelCrossHubMove(id: string): Promise<void> {
  const tracked = useTaskMovesStore.getState().moves[id]
  if (!tracked || tracked.running) return
  const source = getClientForHub(tracked.sourceHubId) as unknown as TasksTrpcClient
  const target = getClientForHub(tracked.move.peerHubId) as unknown as TasksTrpcClient
  // The target's copy first: an abort of a move it never imported is refused (NOT_FOUND).
  await target.taskMoves.abort.mutate({ id }).catch(() => undefined)
  await source.taskMoves.cancel.mutate({ id })
  forget(id)
}

/**
 * Read every hub's unfinished outgoing moves into the store, and run the ones the
 * journal says are running but nobody here runs (the app quit or crashed mid-move).
 * Called at start and whenever a board reloads.
 */
export async function syncCrossHubMoves(hubIds: readonly string[]): Promise<void> {
  const seen = new Set<string>()
  for (const hubId of hubIds) {
    const client = getClientForHub(hubId) as unknown as TasksTrpcClient
    const moves = await client.taskMoves.list
      .query({ statuses: ['running', 'paused', 'failed'] })
      .catch(() => [] as TaskMove[])
    for (const move of moves) {
      if (move.direction !== 'out') continue
      seen.add(move.id)
      const tracked = useTaskMovesStore.getState().moves[move.id]
      if (tracked?.running) continue
      setMove(move.id, {
        move,
        sourceHubId: hubId,
        running: false,
        pauseRequested: tracked?.pauseRequested ?? false
      })
      // Running, but quiet for a while: whoever ran it is gone (quit, crash). A move
      // another device is driving keeps writing progress, so it is left to it.
      if (move.status === 'running' && Date.now() - move.updatedAt > ORPHANED_AFTER_MS)
        void drive(move.id, hubId)
    }
  }
  // A move no hub lists as unfinished any more (done or canceled elsewhere).
  for (const [id, tracked] of Object.entries(useTaskMovesStore.getState().moves)) {
    if (!tracked.running && !seen.has(id) && hubIds.includes(tracked.sourceHubId)) forget(id)
  }
}
