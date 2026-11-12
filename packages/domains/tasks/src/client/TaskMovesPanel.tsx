import { useEffect } from 'react'
import { TASK_MOVE_STEPS, type TaskMoveStep } from '@slayzone/task-contracts'
import { electronBootstrap } from '@slayzone/transport/client'
import { Button, toast } from '@slayzone/ui'
import {
  cancelCrossHubMove,
  pauseCrossHubMove,
  resumeCrossHubMove,
  syncCrossHubMoves,
  useTaskMovesStore,
  type TrackedMove
} from './cross-hub-moves'

const STEP_LABELS: Record<TaskMoveStep, string> = {
  lock: 'Locking',
  export: 'Reading',
  import: 'Writing to the other hub',
  'copy-files': 'Copying files',
  'copy-sessions': 'Copying agent sessions',
  links: 'Linking blockers',
  commit: 'Handing over',
  release: 'Finishing'
}

const QUIT_MESSAGE =
  'A task is being moved to another hub. If you quit, the move pauses and resumes the next time SlayZone starts.'

/** Whole-move progress: finished steps, plus the running step's share. */
function percent(m: TrackedMove): number {
  const steps = TASK_MOVE_STEPS.length
  const at = TASK_MOVE_STEPS.indexOf(m.move.step)
  const p = m.move.progress
  const within = p && p.step === m.move.step && p.total > 0 ? p.done / p.total : 0
  return Math.round(((at + within) / steps) * 100)
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Moves of tasks to another hub (cross-hub-moves.ts): a progress card per unfinished
 * move, with pause, resume and cancel. Mounted once, by the app shell. It also keeps
 * the moves in sync with the hubs (at start — resuming a move left running by a quit
 * or a crash — and on every board reload), and asks before quitting while one runs.
 */
export function TaskMovesPanel({
  hubIds,
  hubName,
  syncKey
}: {
  /** The hubs the app is connected to. */
  hubIds: readonly string[]
  hubName: (hubId: string) => string
  /** Changes when a board reloads: the moves are read again. */
  syncKey: unknown
}): React.JSX.Element | null {
  const moves = useTaskMovesStore((s) => s.moves)
  const anyRunning = Object.values(moves).some((m) => m.running)
  const hubKey = hubIds.join('\n')

  useEffect(() => {
    void syncKey
    void syncCrossHubMoves(hubKey ? hubKey.split('\n') : []).catch((e: unknown) => {
      console.warn('[task-moves] sync failed:', e)
    })
  }, [hubKey, syncKey])

  useEffect(() => {
    void electronBootstrap.setQuitGuard(anyRunning ? { message: QUIT_MESSAGE } : null)
  }, [anyRunning])

  const list = Object.values(moves)
  if (list.length === 0) return null
  return (
    <div
      className="fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2"
      data-testid="task-moves-panel"
    >
      {list.map((m) => {
        const pct = percent(m)
        const n = m.move.taskIds.length
        const canCancel =
          !m.running && TASK_MOVE_STEPS.indexOf(m.move.step) <= TASK_MOVE_STEPS.indexOf('commit')
        const run = (action: () => Promise<void>) => () => {
          action().catch((e: unknown) => toast.error(`Move: ${errorText(e)}`))
        }
        return (
          <div
            key={m.move.id}
            className="flex flex-col gap-2 rounded-lg border border-border bg-popover p-3 text-sm shadow-lg"
            data-testid={`task-move-${m.move.id}`}
            data-status={m.move.status}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">
                Moving {n === 1 ? '1 task' : `${n} tasks`} to {hubName(m.move.peerHubId)}
              </span>
              <span className="text-muted-foreground">{pct}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
            <div className="text-muted-foreground">
              {m.move.status === 'paused'
                ? 'Paused'
                : m.move.status === 'failed'
                  ? `Stopped: ${m.move.error ?? 'error'}`
                  : m.pauseRequested
                    ? `${STEP_LABELS[m.move.step]} — pausing after this step`
                    : STEP_LABELS[m.move.step]}
            </div>
            <div className="flex justify-end gap-2">
              {m.move.status === 'running' && m.running && !m.pauseRequested && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={run(() => pauseCrossHubMove(m.move.id))}
                >
                  Pause
                </Button>
              )}
              {(m.move.status === 'paused' || m.move.status === 'failed') && (
                <Button size="sm" onClick={run(() => resumeCrossHubMove(m.move.id))}>
                  Resume
                </Button>
              )}
              {canCancel && m.move.status !== 'running' && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={run(() => cancelCrossHubMove(m.move.id))}
                >
                  Cancel
                </Button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
