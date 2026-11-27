import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label
} from '@slayzone/ui'
import { WorkspaceDirPicker } from '@slayzone/file-editor/client/WorkspaceDirPicker'
import { placementOn, type Project } from '@slayzone/projects-contracts'
import { useTRPC } from './trpc'
import { HubScope, useHubId, useHubIdForProject } from '@slayzone/transport/client'

/** Sidebar entry point: the project's owning hub handles both actions. */
export function ScopedRelocateProjectDialog(
  props: React.ComponentProps<typeof RelocateProjectDialog>
) {
  const ambientHubId = useHubId()
  const projectHubId = useHubIdForProject(props.project.id)
  const hubId = projectHubId ?? ambientHubId
  if (!hubId) return null
  return (
    <HubScope hubId={hubId}>
      <RelocateProjectDialog {...props} />
    </HubScope>
  )
}

export function RelocateProjectDialog({
  project,
  computerId: onComputer,
  onClose,
  onUpdated
}: {
  project: Project
  /** The computer whose folder moves. Omitted: the one the hub runs the project on. */
  computerId?: string | null
  onClose(): void
  onUpdated(project: Project): void
}) {
  const trpc = useTRPC()
  const relocate = useMutation(trpc.projects.relocate.mutationOptions())
  const computerId = onComputer ?? project.resolved_computer_id
  const sourcePath = placementOn(project, computerId)?.path ?? ''
  const [mode, setMode] = useState<'move' | 'update'>('move')
  const [path, setPath] = useState('')
  const [browse, setBrowse] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!computerId || !path.trim() || busy) return
    setBusy(true)
    setError('')
    void relocate
      .mutateAsync({
        id: project.id,
        computerId,
        sourcePath,
        path: path.trim(),
        mode
      })
      .then((result) => {
        onUpdated(result)
        onClose()
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        setBusy(false)
      })
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Relocate “{project.name}”</DialogTitle>
          <DialogDescription>
            Change this project's folder on the same computer. Tasks, history and project identity
            stay together.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <fieldset disabled={busy} className="space-y-3">
            <legend className="sr-only">Relocation action</legend>
            <label className="flex gap-3 rounded-md border p-3">
              <input
                type="radio"
                name="relocation-action"
                value="move"
                checked={mode === 'move'}
                onChange={() => setMode('move')}
              />
              <span>
                <span className="block font-medium">Move folder</span>
                <span className="text-sm text-muted-foreground">
                  SlayZone moves the folder and its files to a new path, then updates the project.
                  Use this to move or rename the folder.
                </span>
              </span>
            </label>
            <label className="flex gap-3 rounded-md border p-3">
              <input
                type="radio"
                name="relocation-action"
                value="update"
                checked={mode === 'update'}
                onChange={() => setMode('update')}
              />
              <span>
                <span className="block font-medium">Update path</span>
                <span className="text-sm text-muted-foreground">
                  Point SlayZone at an existing folder. Use this after moving the folder yourself.
                  No files are moved.
                </span>
              </span>
            </label>
          </fieldset>
          <div className="space-y-1">
            <Label>Current path</Label>
            <p className="break-all text-sm text-muted-foreground">
              {sourcePath || 'No folder set'}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="relocate-path">
              {mode === 'move' ? 'New folder path' : 'Existing folder path'}
            </Label>
            <div className="flex gap-2">
              <Input
                id="relocate-path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                disabled={busy}
                placeholder="/path/to/project"
                required
              />
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setBrowse(true)}
              >
                Browse…
              </Button>
            </div>
            {mode === 'move' && (
              <p className="text-xs text-muted-foreground">
                Choose an unused folder name inside an existing parent folder. Stop running
                terminals and agents before moving.
              </p>
            )}
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || !computerId || !path.trim() || (mode === 'move' && !sourcePath)}
            >
              {busy ? 'Updating…' : mode === 'move' ? 'Move folder' : 'Update path'}
            </Button>
          </DialogFooter>
        </form>
        <WorkspaceDirPicker
          open={browse}
          onOpenChange={setBrowse}
          onSelect={setPath}
          target={{ computerId, projectId: project.id }}
          defaultPath={sourcePath || null}
          title={
            mode === 'move'
              ? 'Choose destination parent, then enter a new folder name'
              : 'Select existing project folder'
          }
        />
      </DialogContent>
    </Dialog>
  )
}
