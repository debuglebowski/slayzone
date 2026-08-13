import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { Input, cn } from '@slayzone/ui'

/**
 * The machine a computer sits on, as an inline editable label.
 *
 * WHY INLINE RATHER THAN A GROUP HEADER. Grouping only becomes visible when two
 * OS accounts share one box, which is the rare case; a header per machine would
 * add a row of chrome to every list to describe a relationship that is usually
 * one-to-one. The label rides the computer's own row instead, and simply repeats
 * when two rows share a box — which IS the grouping, without new layout.
 *
 * WHY KEYED ON HOST ID. Two machine rows can merge between a render and a click
 * (that is the whole convergence story in `machines.ts`), and a merge DELETES the
 * losing row's id. The host id survives on the winner, so it is the only stable
 * handle a client may hold.
 *
 * Absent machine = ungrouped: a computer too old to report a host id, or one whose
 * id could not be resolved. Renders nothing rather than inventing a placeholder —
 * "unknown box" and "its own box" are different claims.
 */
export function MachineLabel({
  machine
}: {
  machine: { hostId: string; name: string | null } | null
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const rename = useMutation(trpc.computers.renameMachine.mutationOptions())
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  if (!machine) return null

  const commit = async (): Promise<void> => {
    const next = draft.trim()
    setEditing(false)
    // Empty clears the name rather than storing '', so `name IS NULL` stays the
    // single meaning of "never named" — which is what the merge rule reads.
    await rename.mutateAsync({ hostId: machine.hostId, name: next.length > 0 ? next : null })
    await queryClient.invalidateQueries(trpc.computers.list.queryFilter())
  }

  if (editing) {
    return (
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit()
          if (e.key === 'Escape') setEditing(false)
        }}
        placeholder="Machine name"
        className="h-6 max-w-[10rem] text-xs"
        data-testid="machine-rename-input"
      />
    )
  }

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(machine.name ?? '')
        setEditing(true)
      }}
      title={machine.name ? `On ${machine.name}` : 'Name this machine'}
      className={cn(
        'shrink-0 truncate text-xs',
        machine.name ? 'text-muted-foreground' : 'text-muted-foreground/50'
      )}
      data-testid="machine-label"
    >
      {machine.name ?? 'Unnamed machine'}
    </button>
  )
}
