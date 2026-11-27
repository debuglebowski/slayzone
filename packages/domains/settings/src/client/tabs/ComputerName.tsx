import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Pencil } from 'lucide-react'
import { useTRPC } from '../trpc'
import { Input, toast } from '@slayzone/ui'
import type { HubComputers } from './hub-computers'

/**
 * A computer's name in its row, renamed in place (`computers.rename`) — the same
 * inline pattern as {@link MachineLabel}. Opened by clicking the name (a pencil
 * shows on hover) or by the Rename action (`ComputerActionButtons`); which one is
 * editing lives on `hub`. Plain text when it may not be renamed (`hub.canRename`).
 */
export function ComputerName({
  computer,
  hub
}: {
  computer: { id: string; name: string }
  hub: Pick<HubComputers, 'canRename' | 'renamingId' | 'startRename' | 'stopRename'>
}) {
  if (!hub.canRename(computer)) {
    return <span className="shrink-0 text-sm font-medium">{computer.name}</span>
  }
  if (hub.renamingId === computer.id) {
    // Mounted fresh per edit, so the draft always starts from the current name.
    return <ComputerNameInput computer={computer} onDone={hub.stopRename} />
  }
  return (
    <button
      type="button"
      onClick={() => hub.startRename(computer.id)}
      title="Rename this computer"
      className="group/name inline-flex shrink-0 items-center gap-1 text-sm font-medium"
      data-testid="computer-name"
    >
      {computer.name}
      <Pencil
        aria-hidden="true"
        className="text-muted-foreground size-3 opacity-0 transition-opacity group-hover/name:opacity-100 group-focus-visible/name:opacity-100"
        data-testid="computer-name-pencil"
      />
    </button>
  )
}

function ComputerNameInput({
  computer,
  onDone
}: {
  computer: { id: string; name: string }
  onDone: () => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const rename = useMutation(trpc.computers.rename.mutationOptions())
  const [draft, setDraft] = useState(computer.name)
  // Enter/Escape close the editor, and a browser may still fire blur as the input
  // leaves: settle once, so Escape never saves and Enter never saves twice.
  const settled = useRef(false)
  const close = (): boolean => {
    if (settled.current) return false
    settled.current = true
    onDone()
    return true
  }

  const commit = async (): Promise<void> => {
    if (!close()) return
    const next = draft.trim()
    if (!next || next === computer.name) return
    await rename.mutateAsync({ computerId: computer.id, name: next }).catch((err: unknown) => {
      toast.error(err instanceof Error ? err.message : String(err))
    })
    await queryClient.invalidateQueries(trpc.computers.list.queryFilter())
  }

  return (
    <Input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commit()
        if (e.key === 'Escape') close()
      }}
      placeholder="Computer name"
      maxLength={64}
      className="h-6 max-w-[12rem] text-sm"
      data-testid="computer-rename-input"
    />
  )
}
