import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '../trpc'
import { Input, toast } from '@slayzone/ui'

/**
 * A computer's name in its row, renamed in place (`computers.rename`) — the same
 * inline pattern as {@link MachineLabel}. Plain text when it may not be renamed: the
 * desktop app's own computer on its own hub, which that hub finds by its name.
 */
export function ComputerName({
  computer,
  renamable
}: {
  computer: { id: string; name: string }
  renamable: boolean
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const rename = useMutation(trpc.computers.rename.mutationOptions())
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  if (!renamable) return <span className="shrink-0 text-sm font-medium">{computer.name}</span>

  const commit = async (): Promise<void> => {
    const next = draft.trim()
    setEditing(false)
    if (!next || next === computer.name) return
    await rename.mutateAsync({ computerId: computer.id, name: next }).catch((err: unknown) => {
      toast.error(err instanceof Error ? err.message : String(err))
    })
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
        placeholder="Computer name"
        maxLength={64}
        className="h-6 max-w-[12rem] text-sm"
        data-testid="computer-rename-input"
      />
    )
  }

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(computer.name)
        setEditing(true)
      }}
      title="Rename this computer"
      className="shrink-0 text-sm font-medium"
      data-testid="computer-name"
    >
      {computer.name}
    </button>
  )
}
