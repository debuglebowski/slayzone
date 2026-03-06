import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Circle, Loader2 } from 'lucide-react'
import { Button, Card, CardContent, CardHeader, CardTitle } from '@slayzone/ui'
import { Label } from '@slayzone/ui'
import { Input } from '@slayzone/ui'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import { cn } from '@slayzone/ui'
import { resolveColumns, type Project } from '@slayzone/projects/shared'
import { WORKFLOW_CATEGORIES, type WorkflowCategory } from '@slayzone/workflow'
import {
  slugifyStatusName,
  type GithubProjectSummary,
  type IntegrationConnectionPublic,
  type IntegrationProjectMapping,
  type IntegrationSyncMode,
  type LinearProject,
  type LinearTeam,
  type ProviderStatus
} from '@slayzone/integrations/shared'

export type ProjectIntegrationProvider = 'linear' | 'github'
type WizardSyncMode = 'one_way_import' | 'one_way_export' | 'two_way' | 'manual'

interface ProjectIntegrationSetupWizardProps {
  project: Project
  provider: ProjectIntegrationProvider
  initialConnectionId?: string
  connectionLocked?: boolean
  initialTeamId?: string
  initialLinearProjectId?: string
  initialSyncMode?: IntegrationSyncMode
  onCancel: () => void
  onCompleted: (result: {
    provider: ProjectIntegrationProvider
    mapping: IntegrationProjectMapping
    imported: number
  }) => void
}

const STEPS = ['Connect account', 'Choose source', 'Choose mode', 'Set up statuses', 'Review mapping', 'Preview and confirm']

const SYNC_MODE_OPTIONS: Array<{
  value: WizardSyncMode
  label: string
  description: string
  enabled: (provider: ProjectIntegrationProvider) => boolean
}> = [
  {
    value: 'one_way_import',
    label: 'One-way import',
    description: 'External updates flow into SlayZone for this project.',
    enabled: () => true
  },
  {
    value: 'one_way_export',
    label: 'One-way export',
    description: 'SlayZone updates pushed out to external system.',
    enabled: () => false
  },
  {
    value: 'two_way',
    label: 'Two-way sync',
    description: 'Changes can flow in both directions.',
    enabled: (provider) => provider === 'linear'
  },
  {
    value: 'manual',
    label: 'Manual sync only',
    description: 'Sync only when you run it manually.',
    enabled: () => false
  }
]

function toWizardSyncMode(syncMode: IntegrationSyncMode | undefined): WizardSyncMode {
  return syncMode === 'two_way' ? 'two_way' : 'one_way_import'
}

function toPersistedSyncMode(syncMode: WizardSyncMode): IntegrationSyncMode {
  return syncMode === 'two_way' ? 'two_way' : 'one_way'
}

function providerLabel(provider: ProjectIntegrationProvider): string {
  return provider === 'github' ? 'GitHub Projects' : 'Linear'
}

function providerConnectionLabel(provider: ProjectIntegrationProvider): string {
  return provider === 'github' ? 'GitHub' : 'Linear'
}

function providerCredentialLabel(provider: ProjectIntegrationProvider): string {
  return provider === 'github' ? 'Personal access token' : 'Personal API key'
}

function providerCredentialPlaceholder(provider: ProjectIntegrationProvider): string {
  return provider === 'github' ? 'github_pat_***' : 'lin_api_***'
}

export function ProjectIntegrationSetupWizard({
  project,
  provider,
  initialConnectionId,
  connectionLocked = false,
  initialTeamId,
  initialLinearProjectId,
  initialSyncMode,
  onCancel,
  onCompleted
}: ProjectIntegrationSetupWizardProps): React.JSX.Element {
  const [step, setStep] = useState(1)
  const [connections, setConnections] = useState<IntegrationConnectionPublic[]>([])
  const [teams, setTeams] = useState<LinearTeam[]>([])
  const [linearProjects, setLinearProjects] = useState<LinearProject[]>([])
  const [githubProjects, setGithubProjects] = useState<GithubProjectSummary[]>([])
  const [loadingConnections, setLoadingConnections] = useState(false)
  const [loadingTeams, setLoadingTeams] = useState(false)
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [loadingGithubProjects, setLoadingGithubProjects] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [connectingAccount, setConnectingAccount] = useState(false)
  const [showConnectForm, setShowConnectForm] = useState(false)
  const [connectionCredential, setConnectionCredential] = useState('')

  const [connectionId, setConnectionId] = useState(initialConnectionId ?? '')
  const [teamId, setTeamId] = useState(initialTeamId ?? '')
  const [linearProjectId, setLinearProjectId] = useState(initialLinearProjectId ?? '')
  const [githubProjectId, setGithubProjectId] = useState('')
  const [syncMode, setSyncMode] = useState<WizardSyncMode>(toWizardSyncMode(initialSyncMode))
  const [conflictPolicy, setConflictPolicy] = useState<'external' | 'local' | 'latest' | 'manual'>('external')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewLoaded, setPreviewLoaded] = useState(false)
  const [previewCount, setPreviewCount] = useState(0)
  const [previewImportableCount, setPreviewImportableCount] = useState(0)

  const [providerStatuses, setProviderStatuses] = useState<ProviderStatus[]>([])
  const [loadingStatuses, setLoadingStatuses] = useState(false)
  const [categoryOverrides, setCategoryOverrides] = useState<Record<string, WorkflowCategory>>({})
  const [taskRemapping, setTaskRemapping] = useState<Record<string, string>>({})
  const [statusSetupComplete, setStatusSetupComplete] = useState(false)
  const [applyingStatuses, setApplyingStatuses] = useState(false)

  const syncModeOptions = useMemo(
    () => SYNC_MODE_OPTIONS.map((option) => ({ ...option, disabled: !option.enabled(provider) })),
    [provider]
  )

  const mappedStatuses = useMemo(() => resolveColumns(project.columns_config), [project.columns_config])
  const openStatusLabel = useMemo(
    () =>
      mappedStatuses.find((column) =>
        column.category === 'unstarted' ||
        column.category === 'triage' ||
        column.category === 'backlog'
      )?.label ?? mappedStatuses[0]?.label ?? 'Default',
    [mappedStatuses]
  )
  const closedStatusLabel = useMemo(
    () =>
      mappedStatuses.find((column) =>
        column.category === 'completed' ||
        column.category === 'canceled'
      )?.label ?? mappedStatuses[mappedStatuses.length - 1]?.label ?? 'Done',
    [mappedStatuses]
  )

  const selectedGitHubProject = useMemo(
    () => githubProjects.find((githubProject) => githubProject.id === githubProjectId) ?? null,
    [githubProjects, githubProjectId]
  )

  const loadConnections = useCallback(async (options?: { preserveMessage?: boolean }) => {
    setLoadingConnections(true)
    if (!options?.preserveMessage) {
      setMessage('')
    }
    try {
      const loadedConnections = await window.api.integrations.listConnections(provider)
      setConnections(loadedConnections)
      setConnectionId((current) => {
        if (connectionLocked) {
          if (
            initialConnectionId &&
            loadedConnections.some((connection) => connection.id === initialConnectionId)
          ) {
            return initialConnectionId
          }
          return ''
        }

        return current && loadedConnections.some((connection) => connection.id === current)
          ? current
          : loadedConnections[0]?.id || ''
      })
      if (!connectionLocked && loadedConnections.length === 0) {
        setShowConnectForm(true)
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingConnections(false)
    }
  }, [provider, connectionLocked, initialConnectionId])

  useEffect(() => {
    setStep(1)
    setMessage('')
    setConnectionId(initialConnectionId ?? '')
    setTeamId(initialTeamId ?? '')
    setLinearProjectId(initialLinearProjectId ?? '')
    setGithubProjectId('')
    setSyncMode(toWizardSyncMode(initialSyncMode))
    setConflictPolicy('external')
    setPreviewLoading(false)
    setPreviewLoaded(false)
    setPreviewCount(0)
    setPreviewImportableCount(0)
    setShowConnectForm(false)
    setConnectionCredential('')
    setProviderStatuses([])
    setCategoryOverrides({})
    setTaskRemapping({})
    setStatusSetupComplete(false)
  }, [provider, initialConnectionId, initialTeamId, initialLinearProjectId, initialSyncMode, project.id])

  useEffect(() => {
    void loadConnections()
  }, [loadConnections])

  useEffect(() => {
    if (provider !== 'linear') return
    if (!connectionId) {
      setTeams([])
      setTeamId('')
      return
    }
    setLoadingTeams(true)
    void window.api.integrations.listLinearTeams(connectionId)
      .then((loadedTeams) => {
        setTeams(loadedTeams)
        setTeamId((current) => current || loadedTeams[0]?.id || '')
      })
      .catch((error) => {
        setMessage(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        setLoadingTeams(false)
      })
  }, [provider, connectionId])

  useEffect(() => {
    if (provider !== 'linear') return
    if (!connectionId || !teamId) {
      setLinearProjects([])
      return
    }
    setLoadingProjects(true)
    void window.api.integrations.listLinearProjects(connectionId, teamId)
      .then((loadedProjects) => {
        setLinearProjects(loadedProjects)
      })
      .catch((error) => {
        setMessage(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        setLoadingProjects(false)
      })
  }, [provider, connectionId, teamId])

  useEffect(() => {
    if (provider !== 'github') return
    if (!connectionId) {
      setGithubProjects([])
      setGithubProjectId('')
      return
    }
    setLoadingGithubProjects(true)
    void window.api.integrations.listGithubProjects(connectionId)
      .then((loadedProjects) => {
        setGithubProjects(loadedProjects)
        setGithubProjectId((current) => current || loadedProjects[0]?.id || '')
      })
      .catch((error) => {
        setMessage(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        setLoadingGithubProjects(false)
      })
  }, [provider, connectionId])

  // Clear status setup when source changes
  const sourceKey = provider === 'linear'
    ? `${connectionId}:${teamId}:${linearProjectId}`
    : `${connectionId}:${selectedGitHubProject?.id ?? ''}`
  useEffect(() => {
    setProviderStatuses([])
    setCategoryOverrides({})
    setTaskRemapping({})
    setStatusSetupComplete(false)
  }, [sourceKey])

  useEffect(() => {
    if (step !== 4) return
    if (!connectionId) return
    if (providerStatuses.length > 0) return

    const externalTeamId = provider === 'linear' ? teamId : selectedGitHubProject?.owner.login
    const externalProjectId = provider === 'github' ? selectedGitHubProject?.id : (linearProjectId || undefined)
    if (!externalTeamId) return

    setLoadingStatuses(true)
    void window.api.integrations.fetchProviderStatuses({
      connectionId,
      provider,
      externalTeamId,
      externalProjectId
    })
      .then((statuses) => {
        setProviderStatuses(statuses)
      })
      .catch((error) => {
        setMessage(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        setLoadingStatuses(false)
      })
  }, [step, connectionId, provider, teamId, selectedGitHubProject, linearProjectId, providerStatuses.length])

  const handleApplyStatuses = async () => {
    setApplyingStatuses(true)
    setMessage('')
    try {
      await window.api.integrations.applyStatusSync({
        projectId: project.id,
        provider,
        statuses: providerStatuses,
        categoryOverrides: Object.keys(categoryOverrides).length > 0 ? categoryOverrides : undefined,
        taskRemapping: Object.keys(taskRemapping).length > 0 ? taskRemapping : undefined
      })
      setStatusSetupComplete(true)
      setMessage('Statuses synced successfully')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setApplyingStatuses(false)
    }
  }

  useEffect(() => {
    if (step !== 6) return
    if (!connectionId) return

    if (provider === 'linear' && !teamId) return
    if (provider === 'github' && !selectedGitHubProject) return

    setPreviewLoading(true)
    setPreviewLoaded(false)

    const request = provider === 'linear'
      ? window.api.integrations.listLinearIssues({
          connectionId,
          projectId: project.id,
          teamId,
          linearProjectId: linearProjectId || undefined,
          limit: 50
        })
      : window.api.integrations.listGithubIssues({
          connectionId,
          projectId: project.id,
          githubProjectId: selectedGitHubProject?.id,
          limit: 50
        })

    void request
      .then((result) => {
        setPreviewCount(result.issues.length)
        setPreviewImportableCount(result.issues.filter((issue) => !issue.linkedTaskId).length)
        setPreviewLoaded(true)
      })
      .catch((error) => {
        setMessage(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        setPreviewLoading(false)
      })
  }, [provider, step, connectionId, teamId, linearProjectId, selectedGitHubProject, project.id])

  const canGoNext = useMemo(() => {
    if (step === 1) return Boolean(connectionId)
    if (step === 2) {
      if (provider === 'linear') return Boolean(connectionId && teamId)
      return Boolean(connectionId && selectedGitHubProject)
    }
    if (step === 3) return Boolean(syncMode)
    if (step === 4) return statusSetupComplete
    if (step === 5) return true
    return false
  }, [provider, step, connectionId, teamId, selectedGitHubProject, syncMode, statusSetupComplete])

  const persistMapping = async (): Promise<IntegrationProjectMapping> => {
    if (!connectionId) throw new Error('Connection is required')
    if (provider === 'linear') {
      const team = teams.find((item) => item.id === teamId)
      if (!teamId) throw new Error('Team is required')
      return window.api.integrations.setProjectMapping({
        projectId: project.id,
        provider: 'linear',
        connectionId,
        externalTeamId: teamId,
        externalTeamKey: team?.key ?? '',
        externalProjectId: linearProjectId || null,
        syncMode: toPersistedSyncMode(syncMode)
      })
    }

    if (!selectedGitHubProject) throw new Error('GitHub Project is required')
    return window.api.integrations.setProjectMapping({
      projectId: project.id,
      provider: 'github',
      connectionId,
      externalTeamId: selectedGitHubProject.owner.login,
      externalTeamKey: `${selectedGitHubProject.owner.login}#${selectedGitHubProject.number}`,
      externalProjectId: selectedGitHubProject.id,
      syncMode: toPersistedSyncMode(syncMode)
    })
  }

  const handleSaveProfile = async (runImport: boolean) => {
    if (!connectionId) return
    setSaving(true)
    setMessage('')
    try {
      const mapping = await persistMapping()
      let imported = 0
      if (runImport) {
        if (provider === 'linear') {
          const result = await window.api.integrations.importLinearIssues({
            projectId: project.id,
            connectionId,
            teamId,
            linearProjectId: linearProjectId || undefined,
            limit: 50
          })
          imported = result.imported
        } else if (selectedGitHubProject) {
          const result = await window.api.integrations.importGithubIssues({
            projectId: project.id,
            connectionId,
            githubProjectId: selectedGitHubProject.id,
            limit: 50
          })
          imported = result.imported
        }
      }
      onCompleted({ provider, mapping, imported })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const handleConnectAccount = async () => {
    if (!connectionCredential.trim()) return
    setConnectingAccount(true)
    setMessage('')
    try {
      const connection = provider === 'github'
        ? await window.api.integrations.connectGithub({
            token: connectionCredential.trim(),
            projectId: project.id
          })
        : await window.api.integrations.connectLinear({
            apiKey: connectionCredential.trim(),
            projectId: project.id
          })
      setConnectionId(connection.id)
      setConnectionCredential('')
      setShowConnectForm(false)
      setMessage(`${providerConnectionLabel(provider)} connected`)
      await loadConnections({ preserveMessage: true })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setConnectingAccount(false)
    }
  }

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="space-y-4 px-4">
        <div className="space-y-1">
          <CardTitle className="text-base">{provider === 'github' ? 'GitHub Project Setup Wizard' : 'Linear Setup Wizard'}</CardTitle>
          <p className="text-sm text-muted-foreground">
            Configure sync for this project in six quick steps.
          </p>
        </div>
        <div className="grid grid-cols-6 gap-2">
          {STEPS.map((label, index) => {
            const current = index + 1
            const done = current < step
            const active = current === step
            return (
              <button
                key={label}
                type="button"
                onClick={() => setStep(current)}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left transition-colors',
                  active ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/50'
                )}
              >
                {done ? <CheckCircle2 className="size-3 text-primary" /> : <Circle className="size-3 text-muted-foreground" />}
                <span className="line-clamp-1 text-[11px] text-muted-foreground">{label}</span>
              </button>
            )
          })}
        </div>
      </CardHeader>

      <CardContent className="space-y-4 px-4">
        {step === 1 ? (
          <div className="space-y-3">
            <Label htmlFor="wizard-connection">Connection</Label>
            <Select value={connectionId} onValueChange={setConnectionId} disabled={connectionLocked}>
              <SelectTrigger id="wizard-connection" className="w-full max-w-md">
                <SelectValue
                  placeholder={loadingConnections
                    ? 'Loading connections...'
                    : `Select a ${providerConnectionLabel(provider)} connection`}
                />
              </SelectTrigger>
              <SelectContent>
                {connections.map((connection) => (
                  <SelectItem key={connection.id} value={connection.id}>
                    {providerConnectionLabel(provider)} connection
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {loadingConnections ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                Loading available connections...
              </p>
            ) : null}

            <div className="flex items-center justify-between gap-2 rounded-md border border-dashed p-3">
              <p className="text-xs text-muted-foreground">
                {connectionLocked
                  ? `This project uses the ${providerConnectionLabel(provider)} connection chosen in Project Settings.`
                  : connections.length === 0
                    ? `No ${providerLabel(provider)} connection yet. Connect one to continue.`
                    : `Use an existing ${providerConnectionLabel(provider)} connection or connect a new one.`}
              </p>
              {!connectionLocked ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setShowConnectForm((current) => !current)}
                >
                  {showConnectForm ? 'Hide' : 'Connect account'}
                </Button>
              ) : null}
            </div>

            {!connectionLocked && (showConnectForm || connections.length === 0) && (
              <div className="space-y-3 rounded-md border p-3">
                <div className="space-y-1">
                  <Label htmlFor="wizard-connection-credential" className="text-xs text-muted-foreground">
                    {providerCredentialLabel(provider)}
                  </Label>
                  <Input
                    id="wizard-connection-credential"
                    type="password"
                    value={connectionCredential}
                    onChange={(event) => setConnectionCredential(event.target.value)}
                    placeholder={providerCredentialPlaceholder(provider)}
                  />
                </div>
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    disabled={!connectionCredential.trim() || connectingAccount}
                    onClick={() => void handleConnectAccount()}
                  >
                    {connectingAccount ? 'Connecting…' : `Connect ${providerConnectionLabel(provider)}`}
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : null}

        {step === 2 && provider === 'linear' ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="wizard-linear-team">Team</Label>
              <Select value={teamId} onValueChange={setTeamId} disabled={!connectionId || loadingTeams}>
                <SelectTrigger id="wizard-linear-team" className="w-full max-w-md">
                  <SelectValue placeholder={loadingTeams ? 'Loading teams...' : 'Choose a team'} />
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
            <div className="space-y-1">
              <Label htmlFor="wizard-linear-project">Project scope</Label>
              <Select
                value={linearProjectId || '__none__'}
                onValueChange={(value) => setLinearProjectId(value === '__none__' ? '' : value)}
                disabled={!teamId || loadingProjects}
              >
                <SelectTrigger id="wizard-linear-project" className="w-full max-w-md">
                  <SelectValue placeholder={loadingProjects ? 'Loading projects...' : 'Any project in selected team'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Any project in selected team</SelectItem>
                  {linearProjects.map((linearProject) => (
                    <SelectItem key={linearProject.id} value={linearProject.id}>
                      {linearProject.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : null}

        {step === 2 && provider === 'github' ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="wizard-github-project">GitHub Project</Label>
              <Select
                value={githubProjectId}
                onValueChange={setGithubProjectId}
                disabled={!connectionId || loadingGithubProjects}
              >
                <SelectTrigger id="wizard-github-project" className="w-full max-w-md">
                  <SelectValue placeholder={loadingGithubProjects ? 'Loading projects...' : 'Choose a GitHub Project'} />
                </SelectTrigger>
                <SelectContent>
                  {githubProjects.length === 0 ? (
                    <SelectItem value="__none__" disabled>No projects found — use a classic PAT with repo scope</SelectItem>
                  ) : null}
                  {githubProjects.map((githubProject) => (
                    <SelectItem key={githubProject.id} value={githubProject.id}>
                      {githubProject.owner.login}#{githubProject.number} - {githubProject.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedGitHubProject ? (
                <p className="text-xs text-muted-foreground">
                  Sync source: {selectedGitHubProject.owner.login}#{selectedGitHubProject.number}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="space-y-2">
            {syncModeOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                disabled={option.disabled}
                onClick={() => setSyncMode(option.value)}
                className={cn(
                  'w-full rounded-md border px-3 py-2 text-left transition-colors',
                  option.disabled
                    ? 'cursor-not-allowed opacity-50'
                    : syncMode === option.value
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-muted-foreground/50'
                )}
              >
                <p className="text-sm font-medium">{option.label}</p>
                <p className="text-xs text-muted-foreground">{option.description}</p>
                {option.disabled ? <p className="mt-1 text-[11px] text-muted-foreground">Coming soon</p> : null}
              </button>
            ))}

            {provider === 'linear' && syncMode === 'two_way' ? (
              <div className="rounded-md border bg-muted/30 p-3">
                <Label htmlFor="wizard-conflict-policy" className="mb-1 block">Conflict policy</Label>
                <Select
                  value={conflictPolicy}
                  onValueChange={(value) => setConflictPolicy(value as typeof conflictPolicy)}
                >
                  <SelectTrigger id="wizard-conflict-policy" className="w-full max-w-md">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="external">External wins</SelectItem>
                    <SelectItem value="local">SlayZone wins</SelectItem>
                    <SelectItem value="latest">Latest update wins</SelectItem>
                    <SelectItem value="manual">Ask me on conflict</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>
        ) : null}

        {step === 4 ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Import statuses from {providerLabel(provider)} to replace this project's statuses.
            </p>
            {loadingStatuses ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                Loading statuses from {providerLabel(provider)}...
              </p>
            ) : providerStatuses.length > 0 ? (
              <>
                <div className="rounded-md border p-3">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {providerLabel(provider)} statuses
                  </p>
                  <div className="space-y-2">
                    {providerStatuses.map((status) => (
                      <div key={status.id} className="flex items-center justify-between gap-2">
                        <span className="text-sm">{status.name}</span>
                        <Select
                          value={categoryOverrides[status.id] ?? status.type ?? 'unstarted'}
                          onValueChange={(value) =>
                            setCategoryOverrides((prev) => ({ ...prev, [status.id]: value as WorkflowCategory }))
                          }
                        >
                          <SelectTrigger className="w-36">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {WORKFLOW_CATEGORIES.map((cat) => (
                              <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                </div>

                {!statusSetupComplete ? (
                  <div className="rounded-md border p-3">
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Remap existing tasks
                    </p>
                    <p className="mb-2 text-xs text-muted-foreground">
                      Choose where existing tasks should go. Unmapped tasks will move to the default status.
                    </p>
                    <div className="space-y-2">
                      {resolveColumns(project.columns_config).map((col) => (
                        <div key={col.id} className="flex items-center justify-between gap-2">
                          <span className="text-sm">{col.label}</span>
                          <span className="text-xs text-muted-foreground">-&gt;</span>
                          <Select
                            value={taskRemapping[col.id] ?? ''}
                            onValueChange={(value) =>
                              setTaskRemapping((prev) => ({ ...prev, [col.id]: value }))
                            }
                          >
                            <SelectTrigger className="w-40">
                              <SelectValue placeholder="Auto (default)" />
                            </SelectTrigger>
                            <SelectContent>
                              {providerStatuses.map((ps) => (
                                <SelectItem key={ps.id} value={slugifyStatusName(ps.name)}>
                                  {ps.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="flex justify-end">
                  {statusSetupComplete ? (
                    <p className="flex items-center gap-2 text-xs text-green-600">
                      <CheckCircle2 className="size-3" /> Statuses applied
                    </p>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => void handleApplyStatuses()}
                      disabled={applyingStatuses}
                    >
                      {applyingStatuses ? 'Applying...' : 'Apply statuses'}
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">No statuses found.</p>
            )}
          </div>
        ) : null}

        {step === 5 ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Mapping defaults are pre-filled for this scaffold. Required fields are enforced.
            </p>
            <div className="rounded-md border p-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Field mapping</p>
              <ul className="space-y-1 text-sm">
                <li>Title -&gt; Task title</li>
                <li>Description -&gt; Task description</li>
                <li>Status -&gt; Task status</li>
                <li>Assignee -&gt; Task assignee</li>
                <li>Labels -&gt; Task tags</li>
              </ul>
            </div>
            <div className="rounded-md border p-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Status mapping</p>
              {provider === 'linear' ? (
                <div className="space-y-1 text-sm">
                  {mappedStatuses.map((column) => (
                    <p key={column.id}>
                      Linear state type -&gt; {column.label}
                    </p>
                  ))}
                </div>
              ) : (
                <div className="space-y-1 text-sm">
                  <p>Open issues -&gt; {openStatusLabel}</p>
                  <p>Closed issues -&gt; {closedStatusLabel}</p>
                </div>
              )}
            </div>
          </div>
        ) : null}

        {step === 6 ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Review projected first sync impact before confirming.
            </p>
            <div className="rounded-md border p-3">
              {previewLoading ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  Building preview...
                </p>
              ) : previewLoaded ? (
                <div className="space-y-1 text-sm">
                  <p>{previewCount} issues scanned in preview batch</p>
                  <p>{previewImportableCount} issues available to import</p>
                  <p>Mode: {syncMode === 'two_way' ? 'Two-way sync' : 'One-way import'}</p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Preview not loaded yet.</p>
              )}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => void handleSaveProfile(false)} disabled={saving}>
                {saving ? 'Saving...' : 'Save profile without syncing'}
              </Button>
              <Button size="sm" onClick={() => void handleSaveProfile(true)} disabled={saving}>
                {saving ? 'Running...' : 'Run first sync'}
              </Button>
            </div>
          </div>
        ) : null}

        {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}

        <div className="flex items-center justify-between border-t pt-3">
          <div className="text-xs text-muted-foreground">Step {step} of {STEPS.length}</div>
          <div className="flex items-center gap-2">
            {step > 1 ? (
              <Button variant="outline" size="sm" onClick={() => setStep((current) => Math.max(1, current - 1))}>
                Back
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
            )}
            {step < STEPS.length ? (
              <Button size="sm" onClick={() => setStep((current) => Math.min(STEPS.length, current + 1))} disabled={!canGoNext}>
                Next
              </Button>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
