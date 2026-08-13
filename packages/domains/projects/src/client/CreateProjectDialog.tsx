import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  useTRPC,
  useTRPCClient,
  useFederationOrNull,
  getHubClient
} from '@slayzone/transport/client'
import { FolderOpen } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@slayzone/ui'
import { Button, IconButton } from '@slayzone/ui'
import { Input } from '@slayzone/ui'
import { Label } from '@slayzone/ui'
import { ColorPicker } from '@slayzone/ui'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import { cn } from '@slayzone/ui'
import { WorkspaceDirPicker } from '@slayzone/file-editor/client/WorkspaceDirPicker'
import type { Project } from '@slayzone/projects/shared'
export type ProjectStartMode = 'scratch' | 'github' | 'linear'

/** Sentinel for "no explicit binding" — Select has no null value. */
const DEFAULT_COMPUTER_VALUE = '__default__'

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

export function CreateProjectDialog({ open, onOpenChange, onCreated }: CreateProjectDialogProps) {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const [name, setName] = useState('')
  const [color, setColor] = useState(
    () => DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)]
  )
  const [path, setPath] = useState('')
  const [startMode, setStartMode] = useState<ProjectStartMode>('scratch')
  const [loading, setLoading] = useState(false)
  const visibleStartOptions = START_OPTIONS

  // Multi-hub: a new project is created on a chosen hub (it lives in that hub's
  // DB). Default = the registry's default hub; the picker only shows when the
  // client is federated (>1 hub). Single-hub → no picker, create hits the one hub.
  const fed = useFederationOrNull()
  const federatedHubs = fed && fed.hubs.length > 1 ? fed.hubs : []
  const [targetHubId, setTargetHubId] = useState(fed?.defaultHubId ?? 'local')

  // Which MACHINE the project lives on, distinct from which hub owns its row.
  // A hub can have several computers; the path is meaningless without saying whose
  // filesystem it is. Null = the hub's connected default computer.
  const [targetComputerId, setTargetComputerId] = useState<string | null>(null)
  const computersQuery = useQuery(trpc.computers.list.queryOptions())
  const computers = computersQuery.data ?? []
  const [browseOpen, setBrowseOpen] = useState(false)

  const handlePicked = (picked: string): void => {
    setPath(picked)
    // Auto-fill name from the folder name if empty. Split on both separators —
    // the chosen path belongs to the COMPUTER, which may be a different OS.
    if (!name.trim()) setName(picked.split(/[\\/]/).filter(Boolean).pop() ?? '')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    setLoading(true)
    try {
      // Route the create to the chosen hub's client (the project lives in that
      // hub's DB). Default/local resolves to the ambient client → single-hub is
      // unchanged. The federated rail refetches all hubs, so the new project
      // surfaces regardless of which hub owns it.
      const client =
        targetHubId && targetHubId !== fed?.defaultHubId
          ? (getHubClient(targetHubId)?.client ?? trpcClient)
          : trpcClient
      const project = await client.projects.create.mutate({
        name: name.trim(),
        color,
        path: path || undefined
      })
      // Persist the machine choice: the path was browsed on THAT computer, so
      // leaving the binding unset would let a later default change point the
      // project's agents at a filesystem where the path does not exist.
      if (targetComputerId) {
        await client.computers.setProjectDefaultComputer.mutate({
          projectId: project.id,
          computerId: targetComputerId
        })
      }
      onCreated(project, { startMode })
      setName('')
      setPath('')
      setTargetComputerId(null)
      setStartMode('scratch')
      setColor(DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)])
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Project</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="path">Repository Path</Label>
            <div className="flex gap-2">
              <Input
                id="path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/path/to/repo"
                className="flex-1"
              />
              <IconButton
                type="button"
                variant="outline"
                aria-label="Browse folder"
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
              defaultPath={path || null}
              allowCreate
            />
            <p className="text-xs text-muted-foreground">
              Claude Code terminal will open in this directory
            </p>
          </div>
          {/* Only when there is a choice to make. With one computer the path is
              unambiguous, and a select with a single option is noise. */}
          {computers.length > 1 && (
            <div className="space-y-2">
              <Label htmlFor="computer">Machine</Label>
              <Select
                value={targetComputerId ?? DEFAULT_COMPUTER_VALUE}
                onValueChange={(v) => setTargetComputerId(v === DEFAULT_COMPUTER_VALUE ? null : v)}
              >
                <SelectTrigger id="computer" data-testid="create-project-computer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_COMPUTER_VALUE}>Default computer</SelectItem>
                  {computers.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                      {r.usable ? '' : ' (offline)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Whose filesystem the path above refers to, and where this project’s agents run.
              </p>
            </div>
          )}
          <div className="space-y-2">
            <Label>Color</Label>
            <ColorPicker value={color} onChange={setColor} />
          </div>
          {federatedHubs.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="hub">Hub</Label>
              <Select value={targetHubId} onValueChange={setTargetHubId}>
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
                Which hub this project lives on. Its tasks run on that hub.
              </p>
            </div>
          )}
          <div className="space-y-2">
            <Label>How do you want to start this project?</Label>
            <div className="space-y-2">
              {visibleStartOptions.map((option) => (
                <button
                  key={option.mode}
                  type="button"
                  onClick={() => setStartMode(option.mode)}
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                    startMode === option.mode
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
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || loading}>
              {startMode === 'scratch' ? 'Create' : 'Create and continue'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
