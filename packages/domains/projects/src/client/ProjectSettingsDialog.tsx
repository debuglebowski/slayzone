import { useState, useEffect } from 'react'
import {
  FolderOpen,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  Inbox,
  CircleDashed,
  Circle,
  CircleDot,
  CircleCheck,
  CircleX
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@slayzone/ui'
import { SettingsLayout } from '@slayzone/ui'
import { Button, IconButton } from '@slayzone/ui'
import { Input } from '@slayzone/ui'
import { Label } from '@slayzone/ui'
import { ColorPicker } from '@slayzone/ui'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@slayzone/ui'
import { Checkbox } from '@slayzone/ui'
import { Card, CardContent, CardHeader, CardTitle } from '@slayzone/ui'
import { Tabs, TabsList, TabsTrigger } from '@slayzone/ui'
import { cn } from '@slayzone/ui'
import { ContextManagerSettings, type ProjectContextManagerTab } from '../../../ai-config/src/client/ContextManagerSettings'
import {
  DEFAULT_COLUMNS,
  WORKFLOW_CATEGORIES,
  resolveColumns,
  validateColumns,
  type WorkflowCategory,
  type ColumnConfig,
  type Project
} from '@slayzone/projects/shared'
import type {
  IntegrationConnectionPublic,
  IntegrationProjectMapping,
  IntegrationSyncMode,
  LinearIssueSummary,
  LinearProject,
  LinearTeam
} from '@slayzone/integrations/shared'

interface ProjectSettingsDialogProps {
  project: Project | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdated: (project: Project) => void
}

function SettingsTabIntro({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-1">
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="max-w-[80%] text-sm text-muted-foreground" style={{ textWrap: 'balance' }}>{description}</p>
    </div>
  )
}

const CATEGORY_META: Record<
  WorkflowCategory,
  { label: string; icon: LucideIcon }
> = {
  triage: { label: 'Triage', icon: Inbox },
  backlog: { label: 'Backlog', icon: CircleDashed },
  unstarted: { label: 'Unstarted', icon: Circle },
  started: { label: 'Started', icon: CircleDot },
  completed: { label: 'Completed', icon: CircleCheck },
  canceled: { label: 'Canceled', icon: CircleX }
}

const STATUS_COLOR_BADGE: Record<string, string> = {
  gray: 'bg-gray-500/20 text-gray-300',
  slate: 'bg-slate-500/20 text-slate-300',
  blue: 'bg-blue-500/20 text-blue-300',
  yellow: 'bg-yellow-500/20 text-yellow-300',
  purple: 'bg-purple-500/20 text-purple-300',
  green: 'bg-green-500/20 text-green-300',
  red: 'bg-red-500/20 text-red-300',
  orange: 'bg-orange-500/20 text-orange-300'
}

export function ProjectSettingsDialog({
  project,
  open,
  onOpenChange,
  onUpdated
}: ProjectSettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<'general' | 'columns' | 'integrations' | 'ai-config'>('general')
  const [name, setName] = useState('')
  const [color, setColor] = useState('')
  const [path, setPath] = useState('')
  const [autoCreateWorktreeOverride, setAutoCreateWorktreeOverride] = useState<'inherit' | 'on' | 'off'>('inherit')
  const [worktreeSourceBranch, setWorktreeSourceBranch] = useState('')
  const [columnsDraft, setColumnsDraft] = useState<ColumnConfig[]>(() => DEFAULT_COLUMNS.map((column) => ({ ...column })))
  const [loading, setLoading] = useState(false)
  const [connections, setConnections] = useState<IntegrationConnectionPublic[]>([])
  const [teams, setTeams] = useState<LinearTeam[]>([])
  const [linearProjects, setLinearProjects] = useState<LinearProject[]>([])
  const [mapping, setMapping] = useState<IntegrationProjectMapping | null>(null)
  const [connectionId, setConnectionId] = useState<string>('')
  const [teamId, setTeamId] = useState<string>('')
  const [teamKey, setTeamKey] = useState<string>('')
  const [linearProjectId, setLinearProjectId] = useState<string>('')
  const [syncMode, setSyncMode] = useState<IntegrationSyncMode>('one_way')
  const [importing, setImporting] = useState(false)
  const [importMessage, setImportMessage] = useState('')
  const [issueOptions, setIssueOptions] = useState<LinearIssueSummary[]>([])
  const [selectedIssueIds, setSelectedIssueIds] = useState<Set<string>>(new Set())
  const [loadingIssues, setLoadingIssues] = useState(false)
  const [contextManagerTab, setContextManagerTab] = useState<ProjectContextManagerTab>('config')
  const [contextManagerEnabled, setContextManagerEnabled] = useState(false)

  useEffect(() => {
    if (project) {
      setName(project.name)
      setColor(project.color)
      setPath(project.path || '')
      setAutoCreateWorktreeOverride(
        project.auto_create_worktree_on_task_create === 1
          ? 'on'
          : project.auto_create_worktree_on_task_create === 0
            ? 'off'
            : 'inherit'
      )
      setWorktreeSourceBranch(project.worktree_source_branch || '')
      setColumnsDraft(resolveColumns(project.columns_config))
    }
  }, [project])

  useEffect(() => {
    if (open) {
      setActiveTab('general')
      setContextManagerTab('config')
    }
  }, [open, project?.id])

  useEffect(() => {
    let cancelled = false
    void window.api.app.isContextManagerEnabled()
      .then((enabled) => {
        if (!cancelled) setContextManagerEnabled(enabled)
      })
      .catch(() => {
        if (!cancelled) setContextManagerEnabled(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const loadIntegrationState = async () => {
      if (!open || !project) return
      const [loadedConnections, loadedMapping] = await Promise.all([
        window.api.integrations.listConnections('linear'),
        window.api.integrations.getProjectMapping(project.id, 'linear')
      ])
      setConnections(loadedConnections)
      setMapping(loadedMapping)
      setConnectionId(loadedMapping?.connection_id ?? loadedConnections[0]?.id ?? '')
      setTeamId(loadedMapping?.external_team_id ?? '')
      setTeamKey(loadedMapping?.external_team_key ?? '')
      setLinearProjectId(loadedMapping?.external_project_id ?? '')
      setSyncMode(loadedMapping?.sync_mode ?? 'one_way')
      setIssueOptions([])
      setSelectedIssueIds(new Set())
      setImportMessage('')
    }
    void loadIntegrationState()
  }, [open, project?.id])

  useEffect(() => {
    const loadTeams = async () => {
      if (!connectionId) {
        setTeams([])
        return
      }
      const loadedTeams = await window.api.integrations.listLinearTeams(connectionId)
      setTeams(loadedTeams)
      if (!teamId && loadedTeams[0]) {
        setTeamId(loadedTeams[0].id)
        setTeamKey(loadedTeams[0].key)
      }
    }
    void loadTeams()
  }, [connectionId])

  useEffect(() => {
    const loadLinearProjects = async () => {
      if (!connectionId || !teamId) {
        setLinearProjects([])
        return
      }
      const loaded = await window.api.integrations.listLinearProjects(connectionId, teamId)
      setLinearProjects(loaded)
    }
    void loadLinearProjects()
  }, [connectionId, teamId])

  const handleBrowse = async () => {
    const result = await window.api.dialog.showOpenDialog({
      title: 'Select Project Directory',
      defaultPath: path || undefined,
      properties: ['openDirectory']
    })
    if (!result.canceled && result.filePaths[0]) {
      setPath(result.filePaths[0])
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!project || !name.trim()) return

    setLoading(true)
    try {
      const updated = await window.api.db.updateProject({
        id: project.id,
        name: name.trim(),
        color,
        path: path || null,
        autoCreateWorktreeOnTaskCreate:
          autoCreateWorktreeOverride === 'inherit'
            ? null
            : autoCreateWorktreeOverride === 'on',
        worktreeSourceBranch: worktreeSourceBranch.trim() || null
      })

      onUpdated(updated)
    } finally {
      setLoading(false)
    }
  }

  const normalizePositions = (columns: ColumnConfig[]): ColumnConfig[] =>
    columns.map((column, index) => ({ ...column, position: index }))

  const updateColumn = (id: string, update: Partial<ColumnConfig>) => {
    setColumnsDraft((prev) => normalizePositions(prev.map((column) => (
      column.id === id ? { ...column, ...update } : column
    ))))
  }

  const moveColumn = (id: string, category: WorkflowCategory, direction: -1 | 1) => {
    setColumnsDraft((prev) => {
      const sorted = [...prev].sort((a, b) => a.position - b.position)

      const categoryColumns = sorted.filter((column) => column.category === category)
      const categoryIndex = categoryColumns.findIndex((column) => column.id === id)
      const nextCategoryIndex = categoryIndex + direction
      if (categoryIndex < 0 || nextCategoryIndex < 0 || nextCategoryIndex >= categoryColumns.length) return prev

      const nextCategoryColumns = [...categoryColumns]
      const [moved] = nextCategoryColumns.splice(categoryIndex, 1)
      nextCategoryColumns.splice(nextCategoryIndex, 0, moved)

      let replacementIndex = 0
      const next = sorted.map((column) => (
        column.category === category
          ? nextCategoryColumns[replacementIndex++]
          : column
      ))

      return normalizePositions(next)
    })
  }

  const addColumn = (category: WorkflowCategory = 'unstarted') => {
    setColumnsDraft((prev) => {
      const sorted = [...prev].sort((a, b) => a.position - b.position)
      const base = `status-${sorted.length + 1}`
      let id = base
      let n = 2
      const ids = new Set(sorted.map((column) => column.id))
      while (ids.has(id)) {
        id = `${base}-${n}`
        n++
      }
      return [
        ...sorted,
        { id, label: 'New Status', color: 'blue', category, position: sorted.length }
      ]
    })
  }

  const deleteColumn = (id: string) => {
    const next = columnsDraft.filter((column) => column.id !== id)
    if (next.length === columnsDraft.length) return
    if (next.length === 0) return

    setColumnsDraft(normalizePositions(next))
  }

  const handleResetColumns = () => {
    setColumnsDraft(DEFAULT_COLUMNS.map((column) => ({ ...column })))
  }

  const handleSaveColumns = async () => {
    if (!project) return
    let normalized: ColumnConfig[]
    try {
      normalized = validateColumns(normalizePositions(columnsDraft))
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
      return
    }

    const updated = await window.api.db.updateProject({
      id: project.id,
      columnsConfig: normalized
    })
    onUpdated(updated)
    setColumnsDraft(resolveColumns(updated.columns_config))
  }

  const [savingMapping, setSavingMapping] = useState(false)

  const handleSaveMapping = async () => {
    if (!project || !connectionId || !teamId) return
    setSavingMapping(true)
    try {
      const team = teams.find((t) => t.id === teamId)
      const saved = await window.api.integrations.setProjectMapping({
        projectId: project.id,
        provider: 'linear',
        connectionId,
        externalTeamId: teamId,
        externalTeamKey: team?.key ?? teamKey,
        externalProjectId: linearProjectId || null,
        syncMode
      })
      setMapping(saved)
    } finally {
      setSavingMapping(false)
    }
  }

  const handleLoadIssues = async () => {
    if (!connectionId) return
    setLoadingIssues(true)
    setImportMessage('')
    try {
      const result = await window.api.integrations.listLinearIssues({
        connectionId,
        projectId: project?.id,
        teamId: teamId || undefined,
        linearProjectId: linearProjectId || undefined,
        limit: 50
      })
      setIssueOptions(result.issues)
      const importableIds = new Set(result.issues.filter((i) => !i.linkedTaskId).map((i) => i.id))
      setSelectedIssueIds((previous) => new Set([...previous].filter((id) => importableIds.has(id))))
      if (result.issues.length === 0) {
        setImportMessage('No matching Linear issues found')
      }
    } catch (err) {
      setImportMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingIssues(false)
    }
  }

  const handleImportIssues = async () => {
    if (!project || !connectionId) return
    setImporting(true)
    setImportMessage('')
    try {
      const result = await window.api.integrations.importLinearIssues({
        projectId: project.id,
        connectionId,
        teamId: teamId || undefined,
        linearProjectId: linearProjectId || undefined,
        selectedIssueIds: selectedIssueIds.size > 0 ? [...selectedIssueIds] : undefined,
        limit: 50
      })
      setImportMessage(`Imported ${result.imported} issues`)
      if (result.imported > 0) {
        ;(window as any).__slayzone_refreshData?.()
        await handleLoadIssues()
      }
    } catch (err) {
      setImportMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
    }
  }

  const toggleIssue = (issueId: string, checked: boolean) => {
    const next = new Set(selectedIssueIds)
    if (checked) next.add(issueId)
    else next.delete(issueId)
    setSelectedIssueIds(next)
  }

  const hasConnection = Boolean(connectionId)
  const hasTeam = Boolean(teamId)
  const canLoadIssues = hasConnection && hasTeam
  const canImportIssues = hasConnection && hasTeam
  const importableIssues = issueOptions.filter((i) => !i.linkedTaskId)
  const allVisibleIssuesSelected = importableIssues.length > 0 && selectedIssueIds.size === importableIssues.length
  const hasUnsavedMappingChanges =
    mapping != null &&
    (mapping.connection_id !== connectionId ||
      mapping.external_team_id !== teamId ||
      mapping.external_team_key !== teamKey ||
      (mapping.external_project_id ?? '') !== linearProjectId ||
      mapping.sync_mode !== syncMode)

  const navItems: Array<{ key: typeof activeTab; label: string }> = [
    { key: 'general', label: 'General' },
    { key: 'columns', label: 'Task statuses' },
    { key: 'integrations', label: 'Integrations' },
  ]
  if (contextManagerEnabled) {
    navItems.push({ key: 'ai-config', label: 'Context Manager' })
  }
  const colorOptions = ['gray', 'slate', 'blue', 'yellow', 'purple', 'green', 'red', 'orange']
  const sortedColumns = [...columnsDraft].sort((a, b) => a.position - b.position)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="project-settings" className="overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>Project Settings</DialogTitle>
        </DialogHeader>
        <SettingsLayout
          items={navItems}
          activeKey={activeTab}
          onSelect={(key) => setActiveTab(key as typeof activeTab)}
        >
          {activeTab === 'general' && (
            <div className="w-full space-y-6">
              <SettingsTabIntro
                title="General"
                description="Configure the project identity and repository defaults. These settings define where task workflows run and how the project appears in the app."
              />
              <form onSubmit={handleSubmit} className="space-y-6">
                <div className="space-y-1">
                  <Label htmlFor="edit-name">Name</Label>
                  <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="edit-path">Repository Path</Label>
                  <div className="flex gap-2">
                    <Input
                      id="edit-path"
                      value={path}
                      onChange={(e) => setPath(e.target.value)}
                      placeholder="/path/to/repo"
                      className="flex-1"
                    />
                    <IconButton type="button" variant="outline" aria-label="Browse folder" onClick={handleBrowse}>
                      <FolderOpen className="h-4 w-4" />
                    </IconButton>
                  </div>
                  <p className="text-xs text-muted-foreground">Claude Code terminal will open in this directory</p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="auto-create-worktree-override">Auto-create worktree on task creation</Label>
                  <Select
                    value={autoCreateWorktreeOverride}
                    onValueChange={(value) => setAutoCreateWorktreeOverride(value as typeof autoCreateWorktreeOverride)}
                  >
                    <SelectTrigger id="auto-create-worktree-override" className="max-w-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inherit">Use global setting</SelectItem>
                      <SelectItem value="on">Always on</SelectItem>
                      <SelectItem value="off">Always off</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Overrides the global Git setting for this project only.
                  </p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="worktree-source-branch">Worktree source branch</Label>
                  <Input
                    id="worktree-source-branch"
                    value={worktreeSourceBranch}
                    onChange={(e) => setWorktreeSourceBranch(e.target.value)}
                    placeholder="main"
                    className="max-w-sm"
                  />
                  <p className="text-xs text-muted-foreground">
                    Branch to create worktrees from. Defaults to the current branch if empty.
                  </p>
                </div>
                <div className="space-y-1">
                  <Label>Color</Label>
                  <ColorPicker value={color} onChange={setColor} />
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={!name.trim() || loading}>
                    Save
                  </Button>
                </div>
              </form>
            </div>
          )}

          {activeTab === 'columns' && (
            <div className="w-full space-y-6">
              <SettingsTabIntro
                title="Task statuses"
                description="Define the workflow statuses your tasks move through. Group statuses by stage and customize each status name, color, and behavior."
              />
              <div className="space-y-2 rounded-xl border border-border/60 bg-card/30 p-4">
                {WORKFLOW_CATEGORIES.map((category) => {
                  const meta = CATEGORY_META[category]
                  const Icon = meta.icon
                  const rows = sortedColumns.filter((column) => column.category === category)

                  return (
                    <div key={category} className="space-y-1">
                      <div className="flex items-center justify-between rounded-md border border-border/50 bg-muted/60 py-2 pl-3 pr-2">
                        <p className="text-sm font-medium text-foreground/90">{meta.label}</p>
                        <IconButton
                          type="button"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => addColumn(category)}
                          aria-label={`Add ${meta.label} status`}
                        >
                          <Plus className="h-4 w-4" />
                        </IconButton>
                      </div>

                      {rows.length === 0 ? (
                        <div className="py-2 pr-3 text-xs text-muted-foreground">
                          No statuses in this group.
                        </div>
                      ) : (
                        <div className="divide-y divide-border/40">
                          {rows.map((column, index) => (
                            <div
                              key={column.id}
                              className="group py-2 pr-2"
                              data-testid={`project-column-${column.id}`}
                            >
                              <div className="flex items-center gap-2">
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <IconButton
                                      type="button"
                                      variant="ghost"
                                      className={cn(
                                        'h-9 w-9 rounded-md border border-border/50 p-0',
                                        STATUS_COLOR_BADGE[column.color] ?? STATUS_COLOR_BADGE.gray
                                      )}
                                      aria-label="Select status color"
                                    >
                                      <Icon className="h-4 w-4" />
                                    </IconButton>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="start">
                                    {colorOptions.map((value) => (
                                      <DropdownMenuItem
                                        key={value}
                                        onSelect={() => updateColumn(column.id, { color: value })}
                                      >
                                        <span
                                          className={cn(
                                            'mr-2 inline-flex h-2.5 w-2.5 rounded-full',
                                            STATUS_COLOR_BADGE[value] ?? STATUS_COLOR_BADGE.gray
                                          )}
                                        />
                                        {value}
                                      </DropdownMenuItem>
                                    ))}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                                <Input
                                  value={column.label}
                                  onChange={(event) => updateColumn(column.id, { label: event.target.value })}
                                  placeholder="Status label"
                                  className="h-8 border-0 !bg-transparent dark:!bg-transparent px-0 text-sm font-medium shadow-none focus:bg-transparent focus-visible:!bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0"
                                />
                                <div className="ml-1 flex items-center gap-0.5">
                                  <IconButton
                                    type="button"
                                    variant="ghost"
                                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                    data-testid={`move-up-project-column-${column.id}`}
                                    aria-label={`Move ${column.label} status up`}
                                    disabled={index === 0}
                                    onClick={() => moveColumn(column.id, category, -1)}
                                  >
                                    <ChevronUp className="h-4 w-4" />
                                  </IconButton>
                                  <IconButton
                                    type="button"
                                    variant="ghost"
                                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                    data-testid={`move-down-project-column-${column.id}`}
                                    aria-label={`Move ${column.label} status down`}
                                    disabled={index === rows.length - 1}
                                    onClick={() => moveColumn(column.id, category, 1)}
                                  >
                                    <ChevronDown className="h-4 w-4" />
                                  </IconButton>
                                  <IconButton
                                    type="button"
                                    variant="ghost"
                                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                    data-testid={`delete-project-column-${column.id}`}
                                    aria-label={`Delete ${column.label} column`}
                                    onClick={() => deleteColumn(column.id)}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </IconButton>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button type="button" variant="outline" onClick={handleResetColumns}>
                  Reset defaults
                </Button>
                <Button type="button" onClick={handleSaveColumns} data-testid="save-project-columns">
                  Save statuses
                </Button>
              </div>
            </div>
          )}

          {activeTab === 'integrations' && (
            <div className="w-full space-y-6">
              <SettingsTabIntro
                title="Integrations"
                description="Map this project to external systems and control sync flow. Use this tab to connect Linear and import issues safely."
              />
              <Card className="gap-4 py-4">
                <CardHeader className="px-4">
                  <CardTitle className="text-base">Mapping</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 px-4">
                  {connections.length === 0 ? (
                    <div className="rounded-md border border-dashed p-3">
                      <p className="text-sm text-muted-foreground">
                        No Linear connection found. Connect Linear in Settings → Integrations.
                      </p>
                    </div>
                  ) : null}

                  <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                    <Label htmlFor="linear-connection" className="text-sm">
                      Connection
                    </Label>
                    <Select value={connectionId} onValueChange={setConnectionId}>
                      <SelectTrigger id="linear-connection" className="w-full max-w-md">
                        <SelectValue placeholder="Select connection" />
                      </SelectTrigger>
                      <SelectContent>
                        {connections.map((connection) => (
                          <SelectItem key={connection.id} value={connection.id}>
                            {connection.workspace_name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                    <Label htmlFor="linear-team" className="text-sm">
                      Team
                    </Label>
                    <Select
                      value={teamId}
                      onValueChange={(value) => {
                        setTeamId(value)
                        const team = teams.find((t) => t.id === value)
                        setTeamKey(team?.key ?? '')
                      }}
                      disabled={!hasConnection}
                    >
                      <SelectTrigger id="linear-team" className="w-full max-w-md">
                        <SelectValue placeholder="Choose a team" />
                      </SelectTrigger>
                      <SelectContent>
                        {teams.map((team) => (
                          <SelectItem key={team.id} value={team.id}>
                            {team.key} - {team.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                    <Label htmlFor="linear-project-scope" className="text-sm">
                      Project scope
                    </Label>
                    <Select
                      value={linearProjectId || '__none__'}
                      onValueChange={(value) => setLinearProjectId(value === '__none__' ? '' : value)}
                      disabled={!hasTeam}
                    >
                      <SelectTrigger id="linear-project-scope" className="w-full max-w-md">
                        <SelectValue placeholder="Any project in selected team" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Any project in selected team</SelectItem>
                        {linearProjects.map((lp) => (
                          <SelectItem key={lp.id} value={lp.id}>
                            {lp.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-4">
                    <Label htmlFor="linear-sync-mode" className="pt-2 text-sm">
                      Sync mode
                    </Label>
                    <div className="space-y-1">
                      <Select value={syncMode} onValueChange={(value) => setSyncMode(value as IntegrationSyncMode)} disabled={!hasConnection}>
                        <SelectTrigger id="linear-sync-mode" className="w-full max-w-md">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="one_way">One-way (Linear → SlayZone)</SelectItem>
                          <SelectItem value="two_way">Two-way</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        {syncMode === 'two_way'
                          ? 'Two-way: updates sync both directions.'
                          : 'One-way: updates flow from Linear to SlayZone only.'}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    {mapping ? (
                      <p className="text-xs text-muted-foreground">
                        Current mapping: {mapping.external_team_key} ({mapping.sync_mode === 'two_way' ? 'two-way' : 'one-way'})
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">No mapping saved yet</p>
                    )}
                    <Button
                      size="sm"
                      disabled={!hasConnection || !hasTeam || savingMapping}
                      onClick={handleSaveMapping}
                    >
                      {savingMapping ? 'Saving…' : hasUnsavedMappingChanges ? 'Save mapping' : mapping ? 'Mapping saved' : 'Save mapping'}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card className="gap-4 py-4">
                <CardHeader className="px-4">
                  <CardTitle className="text-base">Import Issues</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 px-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs text-muted-foreground">
                      {loadingIssues
                        ? 'Loading issues…'
                        : issueOptions.length > 0
                          ? `${issueOptions.length} issues loaded`
                          : 'Load issues from Linear to import specific tasks'}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canLoadIssues || loadingIssues}
                        onClick={handleLoadIssues}
                      >
                        {loadingIssues ? 'Loading…' : 'Load issues'}
                      </Button>
                      {importableIssues.length > 0 ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (allVisibleIssuesSelected) {
                              setSelectedIssueIds(new Set())
                              return
                            }
                            setSelectedIssueIds(new Set(importableIssues.map((i) => i.id)))
                          }}
                        >
                          {allVisibleIssuesSelected ? 'Clear selection' : 'Select all'}
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  <div className="min-h-40 rounded border p-2">
                    {issueOptions.length > 0 ? (
                      <div className="max-h-44 space-y-1 overflow-y-auto">
                        {issueOptions.map((issue) =>
                          issue.linkedTaskId ? (
                            <div key={issue.id} className="flex items-start gap-2 rounded px-1 py-0.5 text-xs opacity-60">
                              <span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                Linked
                              </span>
                              <span className="min-w-0">
                                <span className="font-medium">{issue.identifier}</span>
                                {' - '}
                                <span className="text-muted-foreground">{issue.title}</span>
                              </span>
                            </div>
                          ) : (
                            <label key={issue.id} className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted/50">
                              <Checkbox
                                checked={selectedIssueIds.has(issue.id)}
                                onCheckedChange={(checked) => toggleIssue(issue.id, checked === true)}
                              />
                              <span className="min-w-0">
                                <span className="font-medium">{issue.identifier}</span>
                                {' - '}
                                <span className="text-muted-foreground">{issue.title}</span>
                              </span>
                            </label>
                          )
                        )}
                      </div>
                    ) : (
                      <div className="flex h-full min-h-36 items-center justify-center text-xs text-muted-foreground">
                        No loaded issues yet.
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                      {selectedIssueIds.size > 0 ? `${selectedIssueIds.size} selected` : 'No specific issues selected'}
                    </p>
                    <Button
                      size="sm"
                      disabled={!canImportIssues || importing}
                      onClick={handleImportIssues}
                    >
                      {importing
                        ? 'Importing…'
                        : selectedIssueIds.size > 0
                          ? `Import selected (${selectedIssueIds.size})`
                          : issueOptions.length > 0
                            ? 'Import all loaded'
                            : 'Import from Linear'}
                    </Button>
                  </div>

                  {importMessage ? (
                    <p className="text-xs text-muted-foreground">{importMessage}</p>
                  ) : null}
                </CardContent>
              </Card>

            </div>
          )}

          {contextManagerEnabled && activeTab === 'ai-config' && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <SettingsTabIntro
                    title="Context Manager"
                    description="Manage project-specific AI instructions, skills, and provider sync behavior. Use this to adapt global context to this project's workflow."
                  />
                </div>
                <Tabs
                  value={contextManagerTab}
                  onValueChange={(value) => setContextManagerTab(value as ProjectContextManagerTab)}
                  className="shrink-0"
                >
                  <TabsList>
                    <TabsTrigger value="config">Config</TabsTrigger>
                    <TabsTrigger value="files">Files</TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
              <ContextManagerSettings
                scope="project"
                projectId={project?.id ?? null}
                projectPath={project?.path}
                projectName={project?.name}
                projectTab={contextManagerTab}
              />
            </div>
          )}
        </SettingsLayout>
      </DialogContent>
    </Dialog>
  )
}
