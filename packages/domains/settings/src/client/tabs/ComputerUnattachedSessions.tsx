import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, TerminalSquare } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  toast
} from '@slayzone/ui'
import { useSubscription } from '@slayzone/transport/client'
import { useTRPC } from '../trpc'

/** Why a session is not attached, in the user's words. Unknown reasons show as-is. */
const REASONS: Record<string, string> = {
  'unknown-session-id': 'Not a task terminal',
  'no-detection': 'This computer is too old to hand it over',
  'computer-too-old': 'This computer is too old to hand it over',
  'task-elsewhere': 'Its task runs on another computer now',
  'mode-mismatch': 'Its tab runs another agent now',
  'not-adoptable': 'The computer could not hand it over',
  'already-tracked': 'Another session is attached to its tab',
  'launch-unresolved': 'Its tab could not be read'
}
/** Where trying again can help (a transient failure); the rest only stop. */
const RETRYABLE = new Set(['not-adoptable', 'launch-unresolved', 'already-tracked'])

function age(startedAt: number | undefined): string {
  if (!startedAt) return ''
  const min = Math.floor((Date.now() - startedAt) / 60_000)
  if (min < 60) return `${String(min)}m`
  return `${String(Math.floor(min / 60))}h${String(min % 60)}m`
}

/**
 * Terminal sessions this computer still runs from before the hub restarted that
 * could not be attached to their tabs (terminal unattached-sessions). They keep
 * running — never killed without the user — so they are shown here, with the user's
 * two actions: Attach (try again) and Stop (after a confirmation). Renders nothing
 * when there are none.
 */
export function ComputerUnattachedSessions({ computerId }: { computerId: string }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [stopping, setStopping] = useState<{ sessionId: string; label: string } | null>(null)
  const listQuery = useQuery({ ...trpc.pty.unattachedList.queryOptions(), retry: false })
  // Pushed by the hub on every change (owner-filtered): no polling.
  useSubscription(
    trpc.pty.onUnattachedChange.subscriptionOptions(undefined, {
      onData: (list) => queryClient.setQueryData(trpc.pty.unattachedList.queryKey(), list)
    })
  )
  const refresh = () => void queryClient.invalidateQueries(trpc.pty.unattachedList.queryFilter())
  const attachMutation = useMutation(trpc.pty.unattachedAttach.mutationOptions())
  const killMutation = useMutation(trpc.pty.unattachedKill.mutationOptions())
  const sessions = (listQuery.data ?? []).filter((s) => s.computerId === computerId)
  if (!sessions.length) return null

  const attach = (sessionId: string) =>
    attachMutation
      .mutateAsync({ computerId, sessionId })
      .then(
        (r) =>
          r.ok
            ? toast.success('Attached to its tab')
            : toast.error(REASONS[r.reason] ?? `Not attached (${r.reason})`),
        (err: unknown) => toast.error(err instanceof Error ? err.message : String(err))
      )
      .finally(refresh)
  const stop = (sessionId: string) =>
    killMutation
      .mutateAsync({ computerId, sessionId })
      .then(
        () => toast.success('Stopped'),
        (err: unknown) => toast.error(err instanceof Error ? err.message : String(err))
      )
      .finally(refresh)

  return (
    <div className="mt-1" data-testid="computer-unattached">
      <button
        type="button"
        className="text-warning-foreground flex items-center gap-1 text-xs"
        onClick={() => setOpen((v) => !v)}
        data-testid="computer-unattached-toggle"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <TerminalSquare className="text-warning size-3" />
        Running, not attached ({sessions.length})
      </button>
      {open && (
        <ul className="border-warning/30 mt-1 space-y-1 border-l pl-3">
          {sessions.map((s) => {
            const reason =
              s.status === 'adopting' ? 'Attaching…' : (REASONS[s.reason ?? ''] ?? s.reason ?? '')
            return (
              <li
                key={s.sessionId}
                className="flex items-start gap-2 text-xs"
                data-testid="computer-unattached-session"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-foreground truncate font-mono">{s.sessionId}</div>
                  <div className="text-muted-foreground truncate" title={s.detail ?? reason}>
                    {[s.mode, s.pid ? `pid ${String(s.pid)}` : '', age(s.startedAt), reason]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                {s.status === 'unattached' && RETRYABLE.has(s.reason ?? '') && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => void attach(s.sessionId)}
                    data-testid="computer-unattached-attach"
                  >
                    Attach
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive h-6 px-2 text-xs"
                  onClick={() => setStopping({ sessionId: s.sessionId, label: s.sessionId })}
                  data-testid="computer-unattached-stop"
                >
                  Stop
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      <AlertDialog open={!!stopping} onOpenChange={(next) => !next && setStopping(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop this session?</AlertDialogTitle>
            <AlertDialogDescription>
              {stopping?.label}: its process ends on the computer, and whatever it is doing stops.
              Its tab and files stay as they are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (stopping) void stop(stopping.sessionId)
                setStopping(null)
              }}
              data-testid="computer-unattached-stop-confirm"
            >
              Stop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
