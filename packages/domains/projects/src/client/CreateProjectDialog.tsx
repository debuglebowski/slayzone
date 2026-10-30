import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { HubScope, useFederationOrNull } from '@slayzone/transport/client'
import { useTRPC, useTRPCClient } from './trpc'
import { FolderOpen } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@slayzone/ui'
import { Button, IconButton } from '@slayzone/ui'
import { Input } from '@slayzone/ui'
import { Label } from '@slayzone/ui'
import { ColorPicker } from '@slayzone/ui'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import { cn } from '@slayzone/ui'
import { WorkspaceDirPicker } from '@slayzone/file-editor/client/WorkspaceDirPicker'
import type { Project } from '@slayzone/projects-contracts'
export type ProjectStartMode = 'scratch' | 'github' | 'linear'

export interface ProjectCreationContext {
  startMode: ProjectStartMode
}

interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (project: Project, context: ProjectCreationContext) => void
}

const DEFAULT_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899']
const START_OPTIONS: Array<{
  mode: ProjectStartMode
  label: string
  description: string
}> = [
  {
    mode: 'scratch',
    label: 'Start from scratch',
    description: 'Create tasks manually and configure integrations later.'
  },
  {
    mode: 'github',
    label: 'Sync with GitHub Projects',
    description: 'Set up project-scoped sync from a GitHub Project board.'
  },
  {
    mode: 'linear',
    label: 'Sync with Linear',
    description: 'Set up project-scoped sync from a Linear team or project.'
  }
]

/** What the user has filled in so far. Lives above the hub scope, so switching hub keeps it. */
interface Draft {
  name: string
  color: string
  path: string
  /** Null until chosen; only asked for when the hub has more than one computer. */
  computerId: string | null
  startMode: ProjectStartMode
}

const randomColor = (): string => DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)]

const emptyDraft = (): Draft => ({
  name: '',
  color: randomColor(),
  path: '',
  computerId: null,
  startMode: 'scratch'
})

export function CreateProjectDialog({ open, onOpenChange, onCreated }: CreateProjectDialogProps) {
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const patch = (next: Partial<Draft>): void => setDraft((d) => ({ ...d, ...next }))

  // Multi-hub: a new project is created on a chosen hub (it lives in that hub's
  // DB). Default = the registry's default hub; the picker only shows when the
  // client is federated (>1 hub). Single-hub → no picker, create hits the one hub.
  const fed = useFederationOrNull()
  const federatedHubs = fed && fed.hubs.length > 1 ? fed.hubs : []
  const [targetHubId, setTargetHubId] = useState(fed?.defaultHubId ?? 'local')

  const handleCreated = (project: Project): void => {
    onCreated(project, { startMode: draft.startMode })
    setDraft(emptyDraft())
  }

  // Computers and folders belong to a hub, so everything below the hub picker
  // talks to the CHOSEN hub: its computers, that computer's disk, and the create
  // itself. The default hub is the ambient client already; another hub gets its
  // own scope.
  const hubBound = (
    <HubBoundFields
      draft={draft}
      patch={patch}
      onCancel={() => onOpenChange(false)}
      onCreated={handleCreated}
    />
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Project</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {federatedHubs.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="hub">Hub</Label>
              <Select
                value={targetHubId}
                onValueChange={(v) => {
                  // Another hub has other computers: the computer and folder chosen
                  // on the previous one mean nothing there.
                  if (v !== targetHubId) patch({ computerId: null, path: '' })
                  setTargetHubId(v)
                }}
              >
                <SelectTrigger id="hub" data-testid="create-project-hub">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {federatedHubs.map((h) => (
                    <SelectItem key={h.id} value={h.id}>
                      {h.label}
                      {h.id === fed?.defaultHubId ? ' (default)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Which hub this project lives on. Its tasks run on that hub’s computers.
              </p>
            </div>
          )}
          {fed && targetHubId !== fed.defaultHubId ? (
            <HubScope
              hubId={targetHubId}
              fallback={
                <p
                  className="text-xs text-destructive"
                  data-testid="create-project-hub-unreachable"
                >
                  This hub is not connected. Pick another hub, or reconnect it in Settings →
                  Connections.
                </p>
              }
            >
              {hubBound}
            </HubScope>
          ) : (
            hubBound
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

interface HubBoundFieldsProps {
  draft: Draft
  patch: (next: Partial<Draft>) => void
  onCancel: () => void
  onCreated: (project: Project) => void
}

/** The part of the form that reads from, and writes to, the hub in scope. */
function HubBoundFields({ draft, patch, onCancel, onCreated }: HubBoundFieldsProps) {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const [loading, setLoading] = useState(false)
  const [browseOpen, setBrowseOpen] = useState(false)

  // Which computer the project's work runs on and its folder lives on — distinct
  // from which hub owns its row. Every project gets one when it is made. With one
  // computer it is that one (the hub picks it); with several the user chooses,
  // since the folder below is a folder on THAT computer.
  const computersQuery = useQuery(trpc.computers.list.queryOptions())
  const computers = computersQuery.data ?? []
  const mustChooseComputer = computers.length > 1
  const targetComputerId = mustChooseComputer ? draft.computerId : null

  const handlePicked = (picked: string): void => {
    // Auto-fill name from the folder name if empty. Split on both separators —
    // the chosen path belongs to the COMPUTER, which may be a different OS.
    patch({
      path: picked,
      ...(draft.name.trim() ? {} : { name: picked.split(/[\\/]/).filter(Boolean).pop() ?? '' })
    })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!draft.name.trim()) return

    setLoading(true)
    // One call, to the hub in scope: it sets the project's default computer (the
    // chosen one, else its only/default one) and records the folder on that
    // computer. The federated rail refetches all hubs, so the new project
    // surfaces regardless of which hub owns it.
    // `.finally()`, not try/finally: the React Compiler skips the latter.
    const project = await trpcClient.projects.create
      .mutate({
        name: draft.name.trim(),
        color: draft.color,
        path: draft.path || undefined,
        ...(targetComputerId ? { computerId: targetComputerId } : {})
      })
      .finally(() => setLoading(false))
    onCreated(project)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          value={draft.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="Project name"
          autoFocus
        />
      </div>
      {/* Only when there is a choice to make. With one computer it is that one,
          and a select with a single option is noise. Above the folder: the folder
          is a folder on this computer. */}
      {mustChooseComputer && (
        <div className="space-y-2">
          <Label htmlFor="computer">Computer</Label>
          <Select
            value={draft.computerId ?? undefined}
            onValueChange={(v) => {
              // A folder is a folder on one computer: another computer's choice
              // makes the one picked below meaningless.
              patch(v !== draft.computerId ? { computerId: v, path: '' } : { computerId: v })
            }}
          >
            <SelectTrigger id="computer" data-testid="create-project-computer">
              <SelectValue placeholder="Choose a computer" />
            </SelectTrigger>
            <SelectContent>
              {computers.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                  {r.usable ? '' : ' (offline)'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Where this project’s agents run, and whose folder the path below is.
          </p>
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="path">Repository Path</Label>
        <div className="flex gap-2">
          <Input
            id="path"
            value={draft.path}
            onChange={(e) => patch({ path: e.target.value })}
            placeholder="/path/to/repo"
            className="flex-1"
          />
          <IconButton
            type="button"
            variant="outline"
            aria-label="Browse folder"
            disabled={mustChooseComputer && !draft.computerId}
            onClick={() => setBrowseOpen(true)}
          >
            <FolderOpen className="h-4 w-4" />
          </IconButton>
        </div>
        <WorkspaceDirPicker
          open={browseOpen}
          onOpenChange={setBrowseOpen}
          onSelect={handlePicked}
          target={{ computerId: targetComputerId }}
          title="Select project directory"
          defaultPath={draft.path || null}
          allowCreate
        />
        <p className="text-xs text-muted-foreground">
          Claude Code terminal will open in this directory
        </p>
      </div>
      <div className="space-y-2">
        <Label>Color</Label>
        <ColorPicker value={draft.color} onChange={(color) => patch({ color })} />
      </div>
      <div className="space-y-2">
        <Label>How do you want to start this project?</Label>
        <div className="space-y-2">
          {START_OPTIONS.map((option) => (
            <button
              key={option.mode}
              type="button"
              onClick={() => patch({ startMode: option.mode })}
              className={cn(
                'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                draft.startMode === option.mode
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-muted-foreground/50'
              )}
            >
              <p className="text-sm font-medium">{option.label}</p>
              <p className="text-xs text-muted-foreground">{option.description}</p>
            </button>
          ))}
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={!draft.name.trim() || loading || (mustChooseComputer && !draft.computerId)}
        >
          {draft.startMode === 'scratch' ? 'Create' : 'Create and continue'}
        </Button>
      </div>
    </form>
  )
}
