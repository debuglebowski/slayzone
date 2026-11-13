import { Button } from '@slayzone/ui'
import { ArrowLeftRight } from 'lucide-react'

/** One `computers.takeovers` offer: `successor` holds chats the hub assigns to `former`. */
export interface ComputerTakeoverOffer {
  former: { id: string; name: string; lastSeenAt: number | null; revoked: boolean }
  successor: { id: string; name: string; connected: boolean }
  conversations: number
  tasks: number
}

/**
 * A computer's name, told apart by its id when another listed computer shares it — a
 * machine enrolled again usually keeps its name, so its old and new rows read the same.
 */
export function computerLabel(
  computer: { id: string; name: string },
  others: ReadonlyArray<{ id: string; name: string }>
): string {
  const shared = others.some((o) => o.id !== computer.id && o.name === computer.name)
  return shared ? `${computer.name} (${computer.id.slice(0, 8)})` : computer.name
}

/**
 * "<new> holds N chats of <old>, which is offline": the hub's evidence that <new> may be
 * <old> enrolled again (its credentials lost, so it got a new id). Until the user replaces
 * <old>, those chats stay fenced to it. Only an offer: the hub cannot prove it is the
 * same machine, so nothing moves without the confirmation `onReplace` opens.
 */
export function ComputerTakeovers({
  takeovers,
  computers,
  onReplace
}: {
  takeovers: readonly ComputerTakeoverOffer[]
  computers: ReadonlyArray<{ id: string; name: string }>
  onReplace: (offer: ComputerTakeoverOffer) => void
}) {
  if (takeovers.length === 0) return null
  return (
    <div className="flex flex-col gap-1 pb-2">
      {takeovers.map((t) => {
        // Both rows are named alike when the machine kept its name: tell them apart.
        const named = [...computers, t.former, t.successor]
        const former = computerLabel(t.former, named)
        const successor = computerLabel(t.successor, named)
        const chats = `${t.conversations} chat${t.conversations === 1 ? '' : 's'}`
        return (
          <div
            key={`${t.former.id}:${t.successor.id}`}
            className="border-border bg-surface-1 flex items-center gap-3 rounded-md border px-3 py-2 text-xs"
            data-testid="computer-takeover"
          >
            <ArrowLeftRight className="text-muted-foreground size-3.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-foreground">
                {successor} holds {chats} of {former}, which is offline
                {t.former.revoked ? ' and revoked' : ''}.
              </div>
              <div className="text-muted-foreground">
                If it is {former} enrolled again, replace {former} with it: its tasks, folders and
                chats move there.
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onReplace(t)}
              data-testid="computer-takeover-replace"
            >
              Replace…
            </Button>
          </div>
        )
      })}
    </div>
  )
}
