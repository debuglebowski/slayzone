import { useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FolderOpen, Pencil } from 'lucide-react'
import { Button, IconButton, Input, StatusDot, toast } from '@slayzone/ui'
import { WorkspaceDirPicker } from '@slayzone/file-editor/client/WorkspaceDirPicker'
import { placementStatus } from '@slayzone/computers/labels'
import type { Project, ProjectPlacement } from '@slayzone/projects-contracts'
import { useTRPC, useTRPCClient } from './trpc'

/**
 * Set and forget a project's folder on ONE named computer (any of the hub's, not
 * only the one the hub runs the project on). Both refresh the hub's project list
 * and hand back the project as it now stands, for a caller holding its own copy.
 */
export function useProjectFolderEditor() {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const queryClient = useQueryClient()

  // The project as the hub now holds it — the folder's status (ready, waiting for the
  // computer, not found) is the hub's answer, not something to guess here.
  const reread = async (project: Project): Promise<Project> => {
    await queryClient.invalidateQueries(trpc.projects.list.queryFilter())
    const all = await queryClient.fetchQuery(trpc.projects.list.queryOptions())
    return all.find((p) => p.id === project.id) ?? project
  }

  return {
    setFolder: async (project: Project, computerId: string, path: string): Promise<Project> => {
      await trpcClient.workspace.setProjectPath.mutate({ computerId, projectId: project.id, path })
      return reread(project)
    },
    forgetFolder: async (project: Project, computerId: string): Promise<Project> => {
      await trpcClient.workspace.forgetProjectPath.mutate({ computerId, projectId: project.id })
      return reread(project)
    }
  }
}

export interface ProjectFolderRowProps {
  /** What the row is about: a computer (project settings) or a project (computer page). */
  name: ReactNode
  /** Beside the name: "Default", the computer's connection state. */
  badges?: ReactNode
  /** The project's folder on this computer, any status; null = none. */
  placement: ProjectPlacement | null
  /** Where Browse… looks: this computer, for this project. */
  browse: { computerId: string; projectId: string }
  onSetFolder: (path: string) => Promise<unknown>
  onForget: () => Promise<unknown>
  /** Move or re-point an existing folder (the Relocate dialog). */
  onRelocate?: () => void
  /** More actions at the end of the row (Make default). */
  actions?: ReactNode
  testId?: string
}

/**
 * One project's folder on one computer: where it is, whether the computer has it,
 * and every way to change it. The same row on both axes — a project's Computers tab
 * and a computer's Folders tab.
 */
export function ProjectFolderRow({
  name,
  badges,
  placement,
  browse,
  onSetFolder,
  onForget,
  onRelocate,
  actions,
  testId
}: ProjectFolderRowProps) {
  const [editing, setEditing] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const folder = placement && placement.status !== 'forgotten' ? placement : null
  const status = placementStatus(folder?.status ?? null)

  // A refusal (outside the computer's allowed folders) or an unreachable computer is
  // the user's to see: they are choosing right now.
  const run = (work: () => Promise<unknown>, failure: string): Promise<void> => {
    setBusy(true)
    return work()
      .then(() => {
        setEditing(null)
      })
      .catch((err: unknown) => {
        toast.error(failure, { description: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => setBusy(false))
  }
  const save = (path: string) => {
    const trimmed = path.trim()
    if (!trimmed || trimmed === folder?.path) {
      setEditing(null)
      return
    }
    void run(() => onSetFolder(trimmed), "Couldn't use that folder")
  }

  return (
    <div
      className="space-y-2 px-4 py-3"
      data-testid={testId}
      data-status={folder?.status ?? 'none'}
    >
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-medium">{name}</span>
          {badges}
        </div>
        <span
          className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
          data-testid={testId && `${testId}-status`}
        >
          <StatusDot tone={status.tone} />
          {status.label}
        </span>
      </div>

      {editing !== null ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            save(editing)
          }}
        >
          <Input
            autoFocus
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                setEditing(null)
              }
            }}
            placeholder="/path/to/repo"
            className="h-8 flex-1 font-mono text-xs"
            disabled={busy}
            aria-label="Folder path"
          />
          <Button type="submit" size="sm" disabled={busy || !editing.trim()}>
            Save
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setEditing(null)}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <div className="flex items-center gap-2">
          {folder ? (
            <span
              className="min-w-0 flex-1 truncate font-mono text-xs"
              title={folder.path}
              data-testid={testId && `${testId}-path`}
            >
              {folder.path}
            </span>
          ) : (
            <span className="min-w-0 flex-1 text-xs text-muted-foreground">No folder</span>
          )}
          <IconButton
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Type a path"
            title="Type a path"
            disabled={busy}
            onClick={() => setEditing(folder?.path ?? '')}
          >
            <Pencil className="size-3.5" />
          </IconButton>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setPicking(true)}
            data-testid={testId && `${testId}-browse`}
          >
            <FolderOpen className="mr-1.5 size-3.5" />
            {folder ? 'Change…' : 'Set folder…'}
          </Button>
          {folder && onRelocate && (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onRelocate}>
              Relocate…
            </Button>
          )}
          {folder && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              title="Forget this folder here. Its files are left alone."
              onClick={() => void run(onForget, "Couldn't forget that folder")}
              data-testid={testId && `${testId}-forget`}
            >
              Forget
            </Button>
          )}
          {actions}
        </div>
      )}

      {status.detail && <p className="text-xs text-muted-foreground">{status.detail}</p>}

      {picking && (
        <WorkspaceDirPicker
          open={picking}
          onOpenChange={setPicking}
          onSelect={save}
          target={browse}
          title="Select project folder"
          defaultPath={folder?.path ?? null}
          allowCreate
        />
      )}
    </div>
  )
}
