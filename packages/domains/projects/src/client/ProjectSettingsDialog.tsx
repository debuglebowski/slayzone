import { useState, useEffect } from 'react'
import { FolderOpen, Copy, Link, Trash2, Plus } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@slayzone/ui'
import { SettingsLayout } from '@slayzone/ui'
import { Button } from '@slayzone/ui'
import { Input } from '@slayzone/ui'
import { Label } from '@slayzone/ui'
import { ColorPicker } from '@slayzone/ui'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import { Checkbox } from '@slayzone/ui'
import { Card, CardContent, CardHeader, CardTitle } from '@slayzone/ui'
import { ContextManagerSettings } from '../../../ai-config/src/client/ContextManagerSettings'
import type { Project } from '@slayzone/projects/shared'
import type {
  IntegrationConnectionPublic,
  IntegrationProjectMapping,
  IntegrationSyncMode,
  LinearIssueSummary,
  LinearProject,
  LinearTeam
} from '@slayzone/integrations/shared'
import type { WorktreeCopyEntry } from '@slayzone/worktrees/shared'
import { copyEntriesKey, legacyCopyEntriesKey, parseCopyEntries } from '@slayzone/worktrees/shared'

interface ProjectSettingsDialogProps {
  project: Project | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdated: (project: Project) => void
}

export function ProjectSettingsDialog({
  project,
  open,
  onOpenChange,
  onUpdated
}: ProjectSettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<'general' | 'integrations' | 'ai-config'>('general')
  const [name, setName] = useState('')
  const [color, setColor] = useState('')
  const [path, setPath] = useState('')
  const [autoCreateWorktreeOverride, setAutoCreateWorktreeOverride] = useState<'inherit' | 'on' | 'off'>('inherit')
  const [worktreeSourceBranch, setWorktreeSourceBranch] = useState('')
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
  const [worktreeCopyFiles, setWorktreeCopyFiles] = useState<WorktreeCopyEntry[]>([])
  const [newCopyPath, setNewCopyPath] = useState('')
  const [newCopyMode, setNewCopyMode] = useState<'copy' | 'symlink'>('copy')

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
      setWorktreeSourceBranch(project.worktree_source_branch ?? '')
    }
  }, [project])

  useEffect(() => {
    if (open) setActiveTab('general')
  }, [open, project?.id])

  useEffect(() => {
    if (!open || !project) { setWorktreeCopyFiles([]); return }
    ;(async () => {
      try {
        // Try new project-id key first (stable)
        let raw = await window.api.settings.get(copyEntriesKey(project.id))
        if (!raw && project.path) {
          // Fallback: legacy path-based key — migrate forward if found
          const legacyRaw = await window.api.settings.get(legacyCopyEntriesKey(project.path))
          if (legacyRaw) {
            window.api.settings.set(copyEntriesKey(project.id), legacyRaw)
            raw = legacyRaw
          }
        }
        const { entries } = parseCopyEntries(raw)
        setWorktreeCopyFiles(entries)
      } catch { setWorktreeCopyFiles([]) }
    })()
  }, [open, project?.id])

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

  const saveCopyFiles = (entries: WorktreeCopyEntry[]) => {
    if (!project) return
    setWorktreeCopyFiles(entries)
    window.api.settings.set(copyEntriesKey(project.id), JSON.stringify(entries))
  }

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
      // No copy-files migration needed on path change — project-id keys are stable

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
    { key: 'integrations', label: 'Integrations' }
    // { key: 'ai-config', label: 'Context Manager' }
  ]

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
            <div className="w-full">
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
                    <Button type="button" variant="outline" size="icon" aria-label="Browse for directory" onClick={handleBrowse}>
                      <FolderOpen className="h-4 w-4" />
                    </Button>
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
                  <Label htmlFor="worktree-source-branch">Branch to create new worktrees from</Label>
                  <Input
                    id="worktree-source-branch"
                    value={worktreeSourceBranch}
                    onChange={(e) => setWorktreeSourceBranch(e.target.value)}
                    placeholder="main"
                    className="max-w-sm font-mono"
                  />
                  <p className="text-xs text-muted-foreground">
                    When creating a new worktree, branch from this branch. Leave empty to use the current branch.
                  </p>
                </div>
                {path && (
                  <div className="space-y-2">
                    <Label>Copy files to new worktrees</Label>
                    <p className="text-xs text-muted-foreground">
                      Files and directories listed here will be copied or symlinked from the source repo into each new worktree. Paths are relative to the repo root (e.g. <code className="font-mono">.env</code>, <code className="font-mono">node_modules</code>).
                    </p>
                    <div className="space-y-1">
                      {worktreeCopyFiles.map((entry, i) => (
                        <div key={i} className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-1.5">
                          {entry.mode === 'symlink' ? (
                            <Link className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          ) : (
                            <Copy className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          )}
                          <span className="flex-1 font-mono text-xs truncate">{entry.path}</span>
                          <span className="text-xs text-muted-foreground shrink-0">{entry.mode}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 shrink-0"
                            aria-label="Remove copy file entry"
                            onClick={() => saveCopyFiles(worktreeCopyFiles.filter((_, j) => j !== i))}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                    <div
                      className="flex gap-2 items-center"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          const trimmed = newCopyPath.trim()
                          if (!trimmed) return
                          saveCopyFiles([...worktreeCopyFiles, { path: trimmed, mode: newCopyMode }])
                          setNewCopyPath('')
                        }
                      }}
                    >
                      <Input
                        className="flex-1 h-8 text-sm font-mono"
                        placeholder=".env"
                        value={newCopyPath}
                        onChange={(e) => setNewCopyPath(e.target.value)}
                      />
                      <Select value={newCopyMode} onValueChange={(v) => setNewCopyMode(v as 'copy' | 'symlink')}>
                        <SelectTrigger className="h-8 w-28">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="copy">Copy</SelectItem>
                          <SelectItem value="symlink">Symlink</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!newCopyPath.trim()}
                        onClick={() => {
                          const trimmed = newCopyPath.trim()
                          if (!trimmed) return
                          saveCopyFiles([...worktreeCopyFiles, { path: trimmed, mode: newCopyMode }])
                          setNewCopyPath('')
                        }}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
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

          {activeTab === 'integrations' && (
            <div className="w-full space-y-6">
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

          {activeTab === 'ai-config' && (
            <ContextManagerSettings
              scope="project"
              projectId={project?.id ?? null}
              projectPath={project?.path}
              projectName={project?.name}
            />
          )}
        </SettingsLayout>
      </DialogContent>
    </Dialog>
  )
}
