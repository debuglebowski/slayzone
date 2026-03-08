import { useState, useEffect, useCallback } from 'react'
import {
  ArrowLeft,
  ChevronRight,
  ExternalLink as ExternalLinkIcon,
  Loader2,
  Pencil,
  Check
} from 'lucide-react'
import { Button } from '@slayzone/ui'
import { toast } from '@slayzone/ui'
import { Input } from '@slayzone/ui'
import { Label } from '@slayzone/ui'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import { Checkbox } from '@slayzone/ui'
import { Card, CardContent, CardHeader, CardTitle } from '@slayzone/ui'
import { Switch } from '@slayzone/ui'
import { cn } from '@slayzone/ui'
import {
  resolveColumns,
  type Project
} from '@slayzone/projects/shared'
import type {
  ExternalLink,
  GithubIssueSummary,
  GithubProjectSummary,
  IntegrationProvider,
  GithubRepositorySummary,
  ImportGithubRepositoryIssuesResult,
  IntegrationConnectionPublic,
  IntegrationProjectMapping,
  IntegrationSyncMode,
  LinearIssueSummary,
  LinearProject,
  LinearTeam,
  TaskSyncStatus
} from '@slayzone/integrations/shared'
import { ProjectIntegrationConnectionModal } from './ProjectIntegrationConnectionModal'
import { providerDisplayName, SettingsTabIntro } from './project-settings-shared'

type GithubTaskSyncRow = {
  taskId: string
  link: ExternalLink
  status: TaskSyncStatus
  error?: string
}

type GithubProjectSyncSummary = {
  total: number
  in_sync: number
  local_ahead: number
  remote_ahead: number
  conflict: number
  unknown: number
  errors: number
  checkedAt: string
}

type IntegrationSetupEntry = 'github_projects' | 'linear' | 'github_issues'
type ImportIssueSort = 'updated_desc' | 'updated_asc' | 'title_asc' | 'title_desc'

function createUnknownGithubStatus(taskId: string): TaskSyncStatus {
  return {
    provider: 'github',
    taskId,
    state: 'unknown',
    fields: [],
    comparedAt: new Date().toISOString()
  }
}

function summarizeGithubRows(rows: GithubTaskSyncRow[]): GithubProjectSyncSummary {
  const summary: GithubProjectSyncSummary = {
    total: rows.length,
    in_sync: 0,
    local_ahead: 0,
    remote_ahead: 0,
    conflict: 0,
    unknown: 0,
    errors: rows.filter((row) => Boolean(row.error)).length,
    checkedAt: new Date().toISOString()
  }
  for (const row of rows) {
    summary[row.status.state] += 1
  }
  return summary
}

function formatGithubImportMessage(result: ImportGithubRepositoryIssuesResult): string {
  const parts = [
    `Imported ${result.imported} issues`,
    `${result.created} new`,
    `${result.updated} refreshed`
  ]
  if (result.skippedAlreadyLinked > 0) {
    parts.push(`${result.skippedAlreadyLinked} skipped (linked to another project)`)
  }
  return parts.join(' \u2022 ')
}

function sortByMode<T extends { title: string; updatedAt: string }>(rows: T[], sort: ImportIssueSort): T[] {
  const next = [...rows]
  next.sort((a, b) => {
    if (sort === 'updated_desc') {
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    }
    if (sort === 'updated_asc') {
      return Date.parse(a.updatedAt) - Date.parse(b.updatedAt)
    }
    if (sort === 'title_desc') {
      return b.title.localeCompare(a.title)
    }
    return a.title.localeCompare(b.title)
  })
  return next
}

interface IntegrationsTabProps {
  project: Project
  open: boolean
  onUpdated: (project: Project) => void
  integrationOnboardingProvider?: IntegrationProvider | null
  onIntegrationOnboardingHandled?: () => void
}

export function IntegrationsTab({
  project,
  open,
  onUpdated,
  integrationOnboardingProvider = null,
  onIntegrationOnboardingHandled
}: IntegrationsTabProps) {
  const [connections, setConnections] = useState<IntegrationConnectionPublic[]>([])
  const [githubConnections, setGithubConnections] = useState<IntegrationConnectionPublic[]>([])
  const [mapping, setMapping] = useState<IntegrationProjectMapping | null>(null)
  const [githubMapping, setGithubMapping] = useState<IntegrationProjectMapping | null>(null)
  const [githubRepositories, setGithubRepositories] = useState<GithubRepositorySummary[]>([])
  const [githubRepositoryFullName, setGithubRepositoryFullName] = useState('')
  const [loadingGithubRepositories, setLoadingGithubRepositories] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importMessage, setImportMessage] = useState('')
  const [issueOptions, setIssueOptions] = useState<LinearIssueSummary[]>([])
  const [linearImportSort, setLinearImportSort] = useState<ImportIssueSort>('updated_desc')
  const [selectedIssueIds, setSelectedIssueIds] = useState<Set<string>>(new Set())
  const [loadingIssues, setLoadingIssues] = useState(false)
  const [githubRepoIssueOptions, setGithubRepoIssueOptions] = useState<GithubIssueSummary[]>([])
  const [githubImportSort, setGithubImportSort] = useState<ImportIssueSort>('updated_desc')
  const [selectedGithubRepoIssueIds, setSelectedGithubRepoIssueIds] = useState<Set<string>>(new Set())
  const [githubRepoIssueQuery, setGithubRepoIssueQuery] = useState('')
  const [loadingGithubRepoIssues, setLoadingGithubRepoIssues] = useState(false)
  const [importingGithubRepoIssues, setImportingGithubRepoIssues] = useState(false)
  const [githubRepoImportMessage, setGithubRepoImportMessage] = useState('')
  const [githubSyncRows, setGithubSyncRows] = useState<GithubTaskSyncRow[]>([])
  const [githubSyncSummary, setGithubSyncSummary] = useState<GithubProjectSyncSummary | null>(null)
  const [checkingGithubSync, setCheckingGithubSync] = useState(false)
  const [pushingGithubSync, setPushingGithubSync] = useState(false)
  const [pullingGithubSync, setPullingGithubSync] = useState(false)
  const [githubSyncMessage, setGithubSyncMessage] = useState('')
  const [selectedIntegrationEntry, setSelectedIntegrationEntry] = useState<IntegrationSetupEntry | null>(
    null
  )
  const [selectedIntegrationMode, setSelectedIntegrationMode] = useState<'continuous' | 'import' | null>(
    integrationOnboardingProvider ? 'continuous' : null
  )
  const [githubProjectConnectionId, setGithubProjectConnectionId] = useState('')
  const [linearProjectConnectionId, setLinearProjectConnectionId] = useState('')
  const [githubSyncProjects, setGithubSyncProjects] = useState<GithubProjectSummary[]>([])
  const [loadingGithubSyncProjects, setLoadingGithubSyncProjects] = useState(false)
  const [githubSyncProjectId, setGithubSyncProjectId] = useState('')
  const [githubSyncRepoFullName, setGithubSyncRepoFullName] = useState('')
  const [githubSyncMode, setGithubSyncMode] = useState<IntegrationSyncMode>('one_way')
  const [linearSyncTeamId, setLinearSyncTeamId] = useState('')
  const [linearSyncProjectId, setLinearSyncProjectId] = useState('')
  const [linearSyncTeams, setLinearSyncTeams] = useState<LinearTeam[]>([])
  const [linearOrgUrlKey, setLinearOrgUrlKey] = useState('')
  const [linearSyncProjects, setLinearSyncProjects] = useState<LinearProject[]>([])
  const [loadingLinearSyncTeams, setLoadingLinearSyncTeams] = useState(false)
  const [loadingLinearSyncProjects, setLoadingLinearSyncProjects] = useState(false)
  const [linearSyncMode, setLinearSyncMode] = useState<IntegrationSyncMode>('one_way')
  const [syncSettingsMessage, setSyncSettingsMessage] = useState('')
  const [savingSyncProvider, setSavingSyncProvider] = useState<IntegrationProvider | null>(null)
  const [pullingLinearSyncNow, setPullingLinearSyncNow] = useState(false)
  const [linearImportTeamId, setLinearImportTeamId] = useState('')
  const [linearImportProjectId, setLinearImportProjectId] = useState('')
  const [linearImportTeams, setLinearImportTeams] = useState<LinearTeam[]>([])
  const [linearImportProjects, setLinearImportProjects] = useState<LinearProject[]>([])
  const [loadingLinearImportTeams, setLoadingLinearImportTeams] = useState(false)
  const [loadingLinearImportProjects, setLoadingLinearImportProjects] = useState(false)
  const [linearImportSourceMessage, setLinearImportSourceMessage] = useState('')
  const [connectionModalState, setConnectionModalState] = useState<{
    provider: IntegrationProvider
    mode: 'connect' | 'edit'
  } | null>(null)
  const [disconnectingProjectConnectionProvider, setDisconnectingProjectConnectionProvider] = useState<IntegrationProvider | null>(null)
  const [switchingProvider, setSwitchingProvider] = useState(false)
  const [syncStep, setSyncStep] = useState<1 | 2 | 3>(1)
  const [syncStepEditing, setSyncStepEditing] = useState<1 | 2 | 3 | null>(null)
  const [loadingSyncStatuses, setLoadingSyncStatuses] = useState(false)

  useEffect(() => {
    if (open) {
      setSelectedIntegrationEntry(
        integrationOnboardingProvider === 'github'
          ? 'github_projects'
          : integrationOnboardingProvider === 'linear'
            ? 'linear'
            : null
      )
      setSelectedIntegrationMode(integrationOnboardingProvider ? 'continuous' : null)
    }
  }, [open, project.id, integrationOnboardingProvider])

  useEffect(() => {
    if (!open) return
    if (!integrationOnboardingProvider) return
    setSelectedIntegrationEntry(integrationOnboardingProvider === 'github' ? 'github_projects' : 'linear')
    setSelectedIntegrationMode('continuous')
    onIntegrationOnboardingHandled?.()
  }, [open, integrationOnboardingProvider, onIntegrationOnboardingHandled])

  const reloadIntegrationState = useCallback(async () => {
    if (!open) return
    const [
      loadedConnections,
      loadedMapping,
      loadedLinearProjectConnectionId,
      loadedGithubConnections,
      loadedGithubMapping,
      loadedGithubProjectConnectionId
    ] = await Promise.all([
      window.api.integrations.listConnections('linear'),
      window.api.integrations.getProjectMapping(project.id, 'linear'),
      window.api.integrations.getProjectConnection(project.id, 'linear'),
      window.api.integrations.listConnections('github'),
      window.api.integrations.getProjectMapping(project.id, 'github'),
      window.api.integrations.getProjectConnection(project.id, 'github')
    ])
    setConnections(loadedConnections)
    setGithubConnections(loadedGithubConnections)
    setMapping(loadedMapping)
    setGithubMapping(loadedGithubMapping)
    setSelectedIntegrationEntry((current) => {
      return current
    })
    const resolvedGithubConnectionId = loadedGithubProjectConnectionId &&
      loadedGithubConnections.some((connection) => connection.id === loadedGithubProjectConnectionId)
      ? loadedGithubProjectConnectionId
      : loadedGithubMapping?.connection_id &&
          loadedGithubConnections.some((connection) => connection.id === loadedGithubMapping.connection_id)
        ? loadedGithubMapping.connection_id
        : ''
    const resolvedLinearConnectionId = loadedLinearProjectConnectionId &&
      loadedConnections.some((connection) => connection.id === loadedLinearProjectConnectionId)
      ? loadedLinearProjectConnectionId
      : loadedMapping?.connection_id &&
          loadedConnections.some((connection) => connection.id === loadedMapping.connection_id)
        ? loadedMapping.connection_id
        : ''

    setGithubProjectConnectionId(resolvedGithubConnectionId)
    setLinearProjectConnectionId(resolvedLinearConnectionId)
    setGithubSyncProjectId(loadedGithubMapping?.external_project_id ?? '')
    setGithubSyncRepoFullName(
      loadedGithubMapping?.external_repo_owner && loadedGithubMapping?.external_repo_name
        ? `${loadedGithubMapping.external_repo_owner}/${loadedGithubMapping.external_repo_name}`
        : ''
    )
    setGithubSyncMode(loadedGithubMapping?.sync_mode ?? 'one_way')
    setLinearSyncTeamId(loadedMapping?.external_team_id ?? '')
    setLinearSyncProjectId(loadedMapping?.external_project_id ?? '')
    setLinearSyncMode(loadedMapping?.sync_mode ?? 'one_way')
    setSyncSettingsMessage('')
    setLinearImportTeamId('')
    setLinearImportProjectId('')
    setLinearImportTeams([])
    setLinearImportProjects([])
    setLinearImportSourceMessage('')
    setGithubRepositories([])
    setGithubRepositoryFullName('')
    setIssueOptions([])
    setSelectedIssueIds(new Set())
    setImportMessage('')
    setGithubRepoIssueOptions([])
    setSelectedGithubRepoIssueIds(new Set())
    setGithubRepoIssueQuery('')
    setGithubRepoImportMessage('')
    setGithubSyncRows([])
    setGithubSyncSummary(null)
    setGithubSyncMessage('')
  }, [open, project])

  useEffect(() => {
    void reloadIntegrationState()
  }, [reloadIntegrationState])

  useEffect(() => {
    const loadGithubRepositories = async () => {
      const connectionId = githubProjectConnectionId || githubMapping?.connection_id
      if (!connectionId) {
        setGithubRepositories([])
        setGithubRepositoryFullName('')
        return
      }
      setLoadingGithubRepositories(true)
      try {
        const repos = await window.api.integrations.listGithubRepositories(connectionId)
        setGithubRepositories(repos)
        setGithubRepositoryFullName((current) => {
          if (current && repos.some((repo) => repo.fullName === current)) return current
          return repos[0]?.fullName ?? ''
        })
        setGithubSyncRepoFullName((current) => {
          if (current && repos.some((repo) => repo.fullName === current)) return current
          return ''
        })
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        setGithubRepoImportMessage(msg)
        console.error('[integrations] Failed to load GitHub repositories:', msg)
        setGithubRepositories([])
        setGithubRepositoryFullName('')
      } finally {
        setLoadingGithubRepositories(false)
      }
    }
    void loadGithubRepositories()
  }, [githubProjectConnectionId, githubMapping?.connection_id])

  useEffect(() => {
    setGithubRepoIssueOptions([])
    setSelectedGithubRepoIssueIds(new Set())
    setGithubRepoIssueQuery('')
    setGithubRepoImportMessage('')
  }, [selectedIntegrationEntry, githubProjectConnectionId, githubMapping?.connection_id, githubRepositoryFullName])

  useEffect(() => {
    if (!githubProjectConnectionId) {
      setGithubSyncProjects([])
      setGithubSyncProjectId('')
      return
    }
    setLoadingGithubSyncProjects(true)
    setSyncSettingsMessage('')
    void window.api.integrations.listGithubProjects(githubProjectConnectionId)
      .then((projects) => {
        setGithubSyncProjects(projects)
        setGithubSyncProjectId((current) => {
          if (current && projects.some((projectOption) => projectOption.id === current)) return current
          if (githubMapping?.external_project_id && projects.some((projectOption) => projectOption.id === githubMapping.external_project_id)) {
            return githubMapping.external_project_id
          }
          return projects[0]?.id ?? ''
        })
      })
      .catch((error) => {
        setSyncSettingsMessage(error instanceof Error ? error.message : String(error))
        setGithubSyncProjects([])
        setGithubSyncProjectId('')
      })
      .finally(() => {
        setLoadingGithubSyncProjects(false)
      })
  }, [githubProjectConnectionId, githubMapping?.external_project_id])

  useEffect(() => {
    if (!linearProjectConnectionId) {
      setLinearSyncTeams([])
      setLinearSyncTeamId('')
      setLinearSyncProjects([])
      setLinearSyncProjectId('')
      return
    }
    setLoadingLinearSyncTeams(true)
    setSyncSettingsMessage('')
    void window.api.integrations.listLinearTeams(linearProjectConnectionId)
      .then((result) => {
        const teams = Array.isArray(result) ? result : result.teams
        setLinearSyncTeams(teams)
        if (!Array.isArray(result)) setLinearOrgUrlKey(result.orgUrlKey)
        setLinearSyncTeamId((current) => {
          if (current && teams.some((team) => team.id === current)) return current
          if (mapping?.external_team_id && teams.some((team) => team.id === mapping.external_team_id)) {
            return mapping.external_team_id
          }
          return teams[0]?.id ?? ''
        })
      })
      .catch((error) => {
        setSyncSettingsMessage(error instanceof Error ? error.message : String(error))
        setLinearSyncTeams([])
        setLinearSyncTeamId('')
      })
      .finally(() => {
        setLoadingLinearSyncTeams(false)
      })
  }, [linearProjectConnectionId, mapping?.external_team_id])

  useEffect(() => {
    if (!linearProjectConnectionId || !linearSyncTeamId) {
      setLinearSyncProjects([])
      setLinearSyncProjectId('')
      return
    }
    setLoadingLinearSyncProjects(true)
    setSyncSettingsMessage('')
    void window.api.integrations.listLinearProjects(linearProjectConnectionId, linearSyncTeamId)
      .then((projects) => {
        setLinearSyncProjects(projects)
        setLinearSyncProjectId((current) => {
          if (current && projects.some((projectOption) => projectOption.id === current)) return current
          if (mapping?.external_project_id && projects.some((projectOption) => projectOption.id === mapping.external_project_id)) {
            return mapping.external_project_id
          }
          return ''
        })
      })
      .catch((error) => {
        setSyncSettingsMessage(error instanceof Error ? error.message : String(error))
        setLinearSyncProjects([])
        setLinearSyncProjectId('')
      })
      .finally(() => {
        setLoadingLinearSyncProjects(false)
      })
  }, [linearProjectConnectionId, linearSyncTeamId, mapping?.external_project_id])

  useEffect(() => {
    if (!linearProjectConnectionId) {
      setLinearImportTeams([])
      setLinearImportTeamId('')
      setLinearImportProjects([])
      setLinearImportProjectId('')
      return
    }
    setLoadingLinearImportTeams(true)
    setLinearImportSourceMessage('')
    void window.api.integrations.listLinearTeams(linearProjectConnectionId)
      .then((result) => {
        const teams = Array.isArray(result) ? result : result.teams
        setLinearImportTeams(teams)
        setLinearImportTeamId((current) => {
          if (current && teams.some((team) => team.id === current)) return current
          return teams[0]?.id ?? ''
        })
      })
      .catch((error) => {
        setLinearImportSourceMessage(error instanceof Error ? error.message : String(error))
        setLinearImportTeams([])
        setLinearImportTeamId('')
      })
      .finally(() => {
        setLoadingLinearImportTeams(false)
      })
  }, [linearProjectConnectionId])

  useEffect(() => {
    if (!linearProjectConnectionId || !linearImportTeamId) {
      setLinearImportProjects([])
      setLinearImportProjectId('')
      return
    }
    setLoadingLinearImportProjects(true)
    setLinearImportSourceMessage('')
    void window.api.integrations.listLinearProjects(linearProjectConnectionId, linearImportTeamId)
      .then((projects) => {
        setLinearImportProjects(projects)
        setLinearImportProjectId((current) => {
          if (current && projects.some((p) => p.id === current)) return current
          return current || ''
        })
      })
      .catch((error) => {
        setLinearImportSourceMessage(error instanceof Error ? error.message : String(error))
        setLinearImportProjects([])
        setLinearImportProjectId('')
      })
      .finally(() => {
        setLoadingLinearImportProjects(false)
      })
  }, [linearProjectConnectionId, linearImportTeamId])

  const handleSelectIntegrationEntry = (
    entry: IntegrationSetupEntry,
    options?: { mode?: 'continuous' | 'import' }
  ) => {
    const activeSyncProvider: IntegrationProvider | null = mapping
      ? 'linear'
      : githubMapping
        ? 'github'
        : null

    if (entry === 'github_issues') {
      setSelectedIntegrationEntry(entry)
      setSelectedIntegrationMode(options?.mode ?? 'import')
      return
    }

    const nextProvider: IntegrationProvider = entry === 'linear' ? 'linear' : 'github'
    const mode = options?.mode ?? 'continuous'
    if (mode === 'continuous' && activeSyncProvider && activeSyncProvider !== nextProvider) {
      window.alert(
        `${providerDisplayName(activeSyncProvider)} sync is active. Disable it first to switch.`
      )
      return
    }

    setSelectedIntegrationEntry(entry)
    setSelectedIntegrationMode(mode)

    if (mode === 'continuous') {
      const existingMapping = nextProvider === 'linear' ? mapping : githubMapping
      if (existingMapping?.status_setup_complete) {
        setSyncStep(3)
        setSyncStepEditing(null)
      } else if (existingMapping) {
        setSyncStep(2)
        setSyncStepEditing(null)
      } else {
        setSyncStep(1)
        setSyncStepEditing(null)
      }
    }
  }

  const handleDisableSyncForProvider = async (provider: IntegrationProvider) => {
    setSwitchingProvider(true)
    try {
      await window.api.integrations.clearProjectProvider({
        projectId: project.id,
        provider
      })
      await reloadIntegrationState()
      setSyncSettingsMessage('Sync disabled')
    } finally {
      setSwitchingProvider(false)
    }
  }

  const handleDisconnectProjectConnection = async (provider: IntegrationProvider) => {
    const confirmed = window.confirm(`Disconnect ${providerDisplayName(provider)} for this project?`)
    if (!confirmed) return

    setDisconnectingProjectConnectionProvider(provider)
    try {
      await window.api.integrations.clearProjectConnection({
        projectId: project.id,
        provider
      })
      if (connectionModalState?.provider === provider) {
        setConnectionModalState(null)
      }
      await reloadIntegrationState()
    } finally {
      setDisconnectingProjectConnectionProvider(null)
    }
  }

  const handleSaveGithubSyncSettings = async () => {
    if (!githubProjectConnectionId || !githubSyncProjectId) {
      setSyncSettingsMessage('Choose a GitHub Project first')
      return
    }
    const selectedProject = githubSyncProjects.find((projectOption) => projectOption.id === githubSyncProjectId)
    if (!selectedProject) {
      setSyncSettingsMessage('Choose a valid GitHub Project')
      return
    }

    const [repoOwner, repoName] = githubSyncRepoFullName.split('/')

    setSavingSyncProvider('github')
    setSyncSettingsMessage('')
    try {
      const saved = await window.api.integrations.setProjectMapping({
        projectId: project.id,
        provider: 'github',
        connectionId: githubProjectConnectionId,
        externalTeamId: selectedProject.owner.login,
        externalTeamKey: `${selectedProject.owner.login}#${selectedProject.number}`,
        externalProjectId: selectedProject.id,
        syncMode: githubSyncMode,
        externalRepoOwner: repoOwner || null,
        externalRepoName: repoName || null
      })
      setGithubMapping(saved)
      setGithubProjectConnectionId(saved.connection_id)
      await reloadIntegrationState()
      setSyncSettingsMessage('Sync settings saved')
    } catch (error) {
      setSyncSettingsMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingSyncProvider(null)
    }
  }

  const handleSaveLinearSyncSettings = async () => {
    if (!linearProjectConnectionId || !linearSyncTeamId) {
      setSyncSettingsMessage('Choose a Linear team first')
      return
    }
    const selectedTeam = linearSyncTeams.find((team) => team.id === linearSyncTeamId)
    if (!selectedTeam) {
      setSyncSettingsMessage('Choose a valid Linear team')
      return
    }

    setSavingSyncProvider('linear')
    setSyncSettingsMessage('')
    try {
      const saved = await window.api.integrations.setProjectMapping({
        projectId: project.id,
        provider: 'linear',
        connectionId: linearProjectConnectionId,
        externalTeamId: selectedTeam.id,
        externalTeamKey: selectedTeam.key,
        externalProjectId: linearSyncProjectId || null,
        syncMode: linearSyncMode
      })
      setMapping(saved)
      setLinearProjectConnectionId(saved.connection_id)
      await reloadIntegrationState()
      setSyncSettingsMessage('Sync settings saved')
    } catch (error) {
      setSyncSettingsMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingSyncProvider(null)
    }
  }

  const handleManualLinearPull = async () => {
    if (!linearSyncEnabled) {
      toast.error('Enable Linear sync first')
      return
    }
    const connectionId = mapping?.connection_id ?? linearProjectConnectionId
    const teamId = mapping?.external_team_id ?? linearSyncTeamId
    const linearProjectId = mapping?.external_project_id ?? (linearSyncProjectId || undefined)
    if (!connectionId || !teamId) {
      toast.error('Save Linear sync settings first')
      return
    }

    setPullingLinearSyncNow(true)
    try {
      let cursor: string | null = null
      let totalImported = 0
      let totalLinked = 0
      let pages = 0
      const maxPages = 20

      do {
        const result = await window.api.integrations.importLinearIssues({
          projectId: project.id,
          connectionId,
          teamId,
          linearProjectId,
          limit: 50,
          cursor
        })
        totalImported += result.imported
        totalLinked += result.linked
        cursor = result.nextCursor
        pages += 1
      } while (cursor && pages < maxPages)

      const truncated = cursor ? ' (partial: reached page limit)' : ''
      toast.success(`Pull complete: ${totalImported} imported/updated, ${totalLinked} linked${truncated}`)
      if (totalImported > 0) {
        ;(window as any).__slayzone_refreshData?.()
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPullingLinearSyncNow(false)
    }
  }

  const handleSyncStepSetupContinue = async () => {
    const provider = syncSetupProvider
    if (!provider) return

    if (provider === 'github') {
      await handleSaveGithubSyncSettings()
    } else {
      await handleSaveLinearSyncSettings()
    }

    const updatedMapping = provider === 'linear' ? mapping : githubMapping
    if (!updatedMapping) return

    setLoadingSyncStatuses(true)
    try {
      const statuses = await window.api.integrations.fetchProviderStatuses({
        connectionId: updatedMapping.connection_id,
        provider,
        externalTeamId: updatedMapping.external_team_id,
        externalProjectId: updatedMapping.external_project_id ?? undefined
      })

      if (!window.confirm(`This will replace your board columns with ${statuses.length} statuses from ${providerDisplayName(provider)}. Continue?`)) {
        return
      }

      const updated = await window.api.integrations.applyStatusSync({
        projectId: project.id,
        provider,
        statuses
      })
      onUpdated(updated)
      ;(window as any).__slayzone_refreshData?.()
      await reloadIntegrationState()
      setSyncStep(3)
      setSyncStepEditing(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingSyncStatuses(false)
    }
  }

  const handleSyncStepEditSetup = () => {
    setSyncStepEditing(1)
  }

  const handleSyncStepResyncStatuses = async () => {
    const provider = syncSetupProvider
    if (!provider) return

    setLoadingSyncStatuses(true)
    try {
      const preview = await window.api.integrations.resyncProviderStatuses({
        projectId: project.id,
        provider
      })
      const { added, removed, renamed } = preview.diff
      const hasChanges = added.length > 0 || removed.length > 0 || renamed.length > 0
      if (!hasChanges) {
        toast.success('Statuses are already in sync')
        return
      }
      const summary = [
        added.length > 0 ? `${added.length} added` : '',
        removed.length > 0 ? `${removed.length} removed` : '',
        renamed.length > 0 ? `${renamed.length} renamed` : ''
      ].filter(Boolean).join(', ')
      if (!window.confirm(`Provider statuses changed: ${summary}. Apply?`)) return

      const updated = await window.api.integrations.applyStatusSync({
        projectId: project.id,
        provider,
        statuses: preview.providerStatuses
      })
      onUpdated(updated)
      ;(window as any).__slayzone_refreshData?.()
      await reloadIntegrationState()
      toast.success('Statuses updated')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingSyncStatuses(false)
    }
  }

  const handleSyncStepCancelEdit = () => {
    setSyncStepEditing(null)
  }

  const handleSyncStepSaveSetupEdit = async () => {
    const provider = syncSetupProvider
    if (!provider) return

    if (provider === 'github') {
      await handleSaveGithubSyncSettings()
    } else {
      await handleSaveLinearSyncSettings()
    }
    setSyncStepEditing(null)
  }

  const handleLoadIssues = async () => {
    const connectionId = linearProjectConnectionId
    const teamId = linearImportTeamId
    const linearProjectId = linearImportProjectId || undefined

    if (!connectionId || !teamId) {
      setImportMessage('Choose account and team first')
      return
    }
    setLoadingIssues(true)
    setImportMessage('')
    try {
      const result = await window.api.integrations.listLinearIssues({
        connectionId,
        projectId: project.id,
        teamId,
        linearProjectId,
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
    const connectionId = linearProjectConnectionId
    const teamId = linearImportTeamId
    const linearProjectId = linearImportProjectId || undefined

    if (!connectionId || !teamId) return
    setImporting(true)
    setImportMessage('')
    try {
      const result = await window.api.integrations.importLinearIssues({
        projectId: project.id,
        connectionId,
        teamId,
        linearProjectId,
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

  const handleLoadGithubRepositoryIssues = async () => {
    const connectionId = githubProjectConnectionId || githubMapping?.connection_id
    if (!connectionId || !githubRepositoryFullName) return
    setLoadingGithubRepoIssues(true)
    setGithubRepoImportMessage('')
    try {
      const result = await window.api.integrations.listGithubRepositoryIssues({
        connectionId,
        projectId: project.id,
        repositoryFullName: githubRepositoryFullName,
        limit: 50
      })
      setGithubRepoIssueOptions(result.issues)
      const importableIds = new Set(result.issues.filter((issue) => !issue.linkedTaskId).map((issue) => issue.id))
      setSelectedGithubRepoIssueIds((previous) => new Set([...previous].filter((id) => importableIds.has(id))))
      if (result.issues.length === 0) {
        setGithubRepoImportMessage('No matching GitHub repository issues found')
      } else if (importableIds.size === 0) {
        setGithubRepoImportMessage('All loaded issues are already linked to tasks')
      }
    } catch (error) {
      setGithubRepoImportMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingGithubRepoIssues(false)
    }
  }

  const handleImportGithubRepositoryIssues = async () => {
    const connectionId = githubProjectConnectionId || githubMapping?.connection_id
    if (!connectionId || !githubRepositoryFullName) return
    setImportingGithubRepoIssues(true)
    setGithubRepoImportMessage('')
    try {
      const importableIdSet = new Set(
        githubRepoIssueOptions.filter((issue) => !issue.linkedTaskId).map((issue) => issue.id)
      )
      const selectedImportableIds = [...selectedGithubRepoIssueIds].filter((id) => importableIdSet.has(id))
      const result = await window.api.integrations.importGithubRepositoryIssues({
        projectId: project.id,
        connectionId,
        repositoryFullName: githubRepositoryFullName,
        selectedIssueIds: selectedImportableIds.length > 0 ? selectedImportableIds : undefined,
        limit: 50
      })
      setGithubRepoImportMessage(formatGithubImportMessage(result))
      if (result.imported > 0) {
        ;(window as any).__slayzone_refreshData?.()
        await Promise.all([
          handleLoadGithubRepositoryIssues(),
          collectGithubSyncRows()
        ])
      }
    } catch (error) {
      setGithubRepoImportMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setImportingGithubRepoIssues(false)
    }
  }

  const collectGithubSyncRows = useCallback(async (): Promise<GithubTaskSyncRow[]> => {
    const tasks = await window.api.db.getTasksByProject(project.id)
    const linkLookups = await Promise.all(
      tasks.map(async (task) => {
        const link = await window.api.integrations.getLink(task.id, 'github')
        return { taskId: task.id, link }
      })
    )
    const linkedEntries = linkLookups.filter(
      (entry): entry is { taskId: string; link: ExternalLink } => Boolean(entry.link)
    )

    const rows = await Promise.all(
      linkedEntries.map(async ({ taskId, link }) => {
        try {
          const status = await window.api.integrations.getTaskSyncStatus(taskId, 'github')
          return { taskId, link, status }
        } catch (error) {
          return {
            taskId,
            link,
            status: createUnknownGithubStatus(taskId),
            error: error instanceof Error ? error.message : String(error)
          }
        }
      })
    )

    setGithubSyncRows(rows)
    setGithubSyncSummary(summarizeGithubRows(rows))
    return rows
  }, [project])

  const handleCheckGithubDiffs = async () => {
    setCheckingGithubSync(true)
    setGithubSyncMessage('')
    try {
      const rows = await collectGithubSyncRows()
      setGithubSyncMessage(`Checked ${rows.length} linked GitHub issues`)
    } catch (error) {
      setGithubSyncMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setCheckingGithubSync(false)
    }
  }

  const handlePushGithubLocalAhead = async () => {
    setPushingGithubSync(true)
    setGithubSyncMessage('')
    try {
      const rows = githubSyncRows.length > 0 ? githubSyncRows : await collectGithubSyncRows()
      const targets = rows.filter((row) => row.status.state === 'local_ahead')
      if (targets.length === 0) {
        setGithubSyncMessage('No local-ahead tasks to push')
        return
      }

      let pushed = 0
      let skipped = 0
      let errors = 0
      for (const target of targets) {
        try {
          const result = await window.api.integrations.pushTask({
            taskId: target.taskId,
            provider: 'github'
          })
          if (result.pushed) pushed += 1
          else skipped += 1
        } catch {
          errors += 1
        }
      }
      if (pushed > 0) {
        ;(window as any).__slayzone_refreshData?.()
      }
      setGithubSyncMessage(`Push complete: ${pushed} pushed, ${skipped} skipped${errors > 0 ? `, ${errors} errors` : ''}`)
      await collectGithubSyncRows()
    } catch (error) {
      setGithubSyncMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setPushingGithubSync(false)
    }
  }

  const handlePullGithubRemoteAhead = async () => {
    setPullingGithubSync(true)
    setGithubSyncMessage('')
    try {
      const rows = githubSyncRows.length > 0 ? githubSyncRows : await collectGithubSyncRows()
      const targets = rows.filter((row) => row.status.state === 'remote_ahead')
      if (targets.length === 0) {
        setGithubSyncMessage('No remote-ahead tasks to pull')
        return
      }

      let pulled = 0
      let skipped = 0
      let errors = 0
      for (const target of targets) {
        try {
          const result = await window.api.integrations.pullTask({
            taskId: target.taskId,
            provider: 'github'
          })
          if (result.pulled) pulled += 1
          else skipped += 1
        } catch {
          errors += 1
        }
      }
      if (pulled > 0) {
        ;(window as any).__slayzone_refreshData?.()
      }
      setGithubSyncMessage(`Pull complete: ${pulled} pulled, ${skipped} skipped${errors > 0 ? `, ${errors} errors` : ''}`)
      await collectGithubSyncRows()
    } catch (error) {
      setGithubSyncMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setPullingGithubSync(false)
    }
  }

  const toggleIssue = (issueId: string, checked: boolean) => {
    const next = new Set(selectedIssueIds)
    if (checked) next.add(issueId)
    else next.delete(issueId)
    setSelectedIssueIds(next)
  }

  const toggleGithubRepoIssue = (issueId: string, checked: boolean) => {
    const next = new Set(selectedGithubRepoIssueIds)
    if (checked) next.add(issueId)
    else next.delete(issueId)
    setSelectedGithubRepoIssueIds(next)
  }

  const linearMappingSource = mapping
  const githubMappingSource = githubMapping
  const isGithubContinuousView = selectedIntegrationEntry === 'github_projects' && selectedIntegrationMode === 'continuous'
  const isGithubImportView = selectedIntegrationEntry === 'github_issues' && selectedIntegrationMode === 'import'
  const isLinearContinuousView = selectedIntegrationEntry === 'linear' && selectedIntegrationMode === 'continuous'
  const isLinearImportView = selectedIntegrationEntry === 'linear' && selectedIntegrationMode === 'import'
  const syncSetupProvider: IntegrationProvider | null = selectedIntegrationEntry === 'linear'
    ? 'linear'
    : selectedIntegrationEntry === 'github_projects'
      ? 'github'
      : null
  const activeSyncProvider: IntegrationProvider | null = linearMappingSource
    ? 'linear'
    : githubMappingSource
      ? 'github'
      : null
  const githubSyncEnabled = Boolean(githubMappingSource)
  const linearSyncEnabled = Boolean(linearMappingSource)
  const githubConnected = Boolean(githubProjectConnectionId)
  const linearConnected = Boolean(linearProjectConnectionId)
  const syncCurrentMapping = syncSetupProvider === 'linear' ? linearMappingSource : githubMappingSource
  const syncStep1Complete = Boolean(syncCurrentMapping)
  const syncStep2Complete = Boolean(syncCurrentMapping?.status_setup_complete)
  const syncAllStepsComplete = syncStep1Complete && syncStep2Complete

  const syncStep1Summary = (() => {
    if (!syncCurrentMapping) return ''
    if (syncSetupProvider === 'linear') {
      const team = linearSyncTeams.find((t) => t.id === syncCurrentMapping.external_team_id)
      const mode = syncCurrentMapping.sync_mode === 'two_way' ? 'Two-way' : 'One-way'
      return `${team?.key ?? syncCurrentMapping.external_team_key} \u00b7 ${mode}`
    }
    const proj = githubSyncProjects.find((p) => p.id === syncCurrentMapping.external_project_id)
    const mode = syncCurrentMapping.sync_mode === 'two_way' ? 'Two-way' : 'One-way'
    return `${proj ? `${proj.owner.login}#${proj.number}` : syncCurrentMapping.external_team_key} \u00b7 ${mode}`
  })()

  const syncExternalUrl = (() => {
    if (!syncCurrentMapping) return null
    if (syncSetupProvider === 'linear') {
      if (!linearOrgUrlKey) return null
      const teamKey = linearSyncTeams.find((t) => t.id === syncCurrentMapping.external_team_id)?.key ?? syncCurrentMapping.external_team_key
      return `https://linear.app/${linearOrgUrlKey}/team/${teamKey}`
    }
    const proj = githubSyncProjects.find((p) => p.id === syncCurrentMapping.external_project_id)
    return proj?.url ?? null
  })()

  const syncExternalUrlLoading = Boolean(
    syncCurrentMapping && !syncExternalUrl &&
    (syncSetupProvider === 'linear' ? loadingLinearSyncTeams : loadingGithubSyncProjects)
  )

  const githubProjectsDisabled = activeSyncProvider === 'linear'
  const linearDisabled = activeSyncProvider === 'github'
  const githubRepositoryConnectionId = githubProjectConnectionId || githubMappingSource?.connection_id || ''
  const linearIssueConnectionId = linearProjectConnectionId
  const linearIssueTeamId = linearImportTeamId
  const canLoadIssues = Boolean(linearIssueConnectionId && linearIssueTeamId)
  const canImportIssues = Boolean(linearIssueConnectionId && linearIssueTeamId)
  const sortedLinearIssueOptions = sortByMode(issueOptions, linearImportSort)
  const importableIssues = sortedLinearIssueOptions.filter((i) => !i.linkedTaskId)
  const allVisibleIssuesSelected = importableIssues.length > 0 && selectedIssueIds.size === importableIssues.length
  const canLoadGithubRepoIssues = Boolean(githubRepositoryConnectionId && githubRepositoryFullName)
  const githubRepoIssueQueryNormalized = githubRepoIssueQuery.trim().toLowerCase()
  const githubRepoSortedIssues = sortByMode(githubRepoIssueOptions, githubImportSort)
  const githubRepoFilteredIssues = githubRepoIssueQueryNormalized
    ? githubRepoSortedIssues.filter((issue) =>
        `${issue.repository.fullName}#${issue.number} ${issue.title}`.toLowerCase().includes(githubRepoIssueQueryNormalized)
      )
    : githubRepoSortedIssues
  const githubRepoImportableIssues = githubRepoSortedIssues.filter((issue) => !issue.linkedTaskId)
  const githubRepoVisibleImportableIssues = githubRepoFilteredIssues.filter((issue) => !issue.linkedTaskId)
  const githubRepoLinkedInProjectCount = githubRepoSortedIssues.filter(
    (issue) => issue.linkedTaskId && issue.linkedProjectId === project.id
  ).length
  const githubRepoLinkedElsewhereCount = githubRepoSortedIssues.filter(
    (issue) => issue.linkedTaskId && issue.linkedProjectId && issue.linkedProjectId !== project.id
  ).length
  const githubRepoImportableIdSet = new Set(githubRepoImportableIssues.map((issue) => issue.id))
  const selectedGithubRepoImportableCount = [...selectedGithubRepoIssueIds].filter((id) =>
    githubRepoImportableIdSet.has(id)
  ).length
  const canImportGithubRepoIssues = Boolean(
    githubRepositoryConnectionId &&
    githubRepositoryFullName &&
    (githubRepoSortedIssues.length === 0 || githubRepoImportableIssues.length > 0 || selectedGithubRepoImportableCount > 0)
  )
  const allVisibleGithubRepoIssuesSelected =
    githubRepoVisibleImportableIssues.length > 0 &&
    githubRepoVisibleImportableIssues.every((issue) => selectedGithubRepoIssueIds.has(issue.id))
  const githubSummary = githubSyncSummary ?? {
    total: 0,
    in_sync: 0,
    local_ahead: 0,
    remote_ahead: 0,
    conflict: 0,
    unknown: 0,
    errors: 0,
    checkedAt: ''
  }

  const integrationCategoryItems: Array<{
    provider: IntegrationProvider
    title: string
    items: Array<{
      key: string
      entry: IntegrationSetupEntry
      mode: 'continuous' | 'import'
      label: string
      description: string
      disabled: boolean
      testId: string
    }>
  }> = [
    {
      provider: 'github',
      title: 'GitHub',
      items: [
        {
          key: 'github-continuous-sync',
          entry: 'github_projects',
          mode: 'continuous',
          label: 'Continuous sync',
          description: 'Sync with a GitHub Project.',
          disabled: switchingProvider || githubProjectsDisabled,
          testId: 'project-integration-provider-github'
        },
        {
          key: 'github-one-time-import',
          entry: 'github_issues',
          mode: 'import',
          label: 'One-time import',
          description: 'Import regular GitHub issues.',
          disabled: switchingProvider,
          testId: 'project-integration-provider-github-issues'
        }
      ]
    },
    {
      provider: 'linear',
      title: 'Linear',
      items: [
        {
          key: 'linear-continuous-sync',
          entry: 'linear',
          mode: 'continuous',
          label: 'Continuous sync',
          description: 'Sync with a Linear team/project.',
          disabled: switchingProvider || linearDisabled,
          testId: 'project-integration-provider-linear'
        },
        {
          key: 'linear-one-time-import',
          entry: 'linear',
          mode: 'import',
          label: 'One-time import',
          description: 'Import Linear issues once.',
          disabled: switchingProvider,
          testId: 'project-integration-provider-linear-import'
        }
      ]
    }
  ]
  const selectedIntegrationViewMeta = (() => {
    if (isGithubContinuousView) {
      return {
        title: 'GitHub - Continuous sync',
        description: 'Set up and run continuous sync with a GitHub Project.'
      }
    }
    if (isGithubImportView) {
      return {
        title: 'GitHub - One-time import',
        description: 'Import regular GitHub repository issues once.'
      }
    }
    if (isLinearContinuousView) {
      return {
        title: 'Linear - Continuous sync',
        description: 'Set up and run continuous sync with a Linear team/project.'
      }
    }
    if (isLinearImportView) {
      return {
        title: 'Linear - One-time import',
        description: 'Import Linear issues once into this project.'
      }
    }
    return {
      title: 'Integrations',
      description: 'Choose an integration item to continue.'
    }
  })()

  return (
    <div className="w-full space-y-6">
      <SettingsTabIntro
        title="Integrations"
        description="Choose one integration path, then configure its project-specific connection and mapping."
      />

      {selectedIntegrationEntry === null ? (
        <div className="space-y-3">
          <div className="space-y-6">
            {integrationCategoryItems.map((category) => {
              const providerConnection = category.provider === 'github'
                ? githubConnections.find((connection) => connection.id === githubProjectConnectionId) ?? null
                : connections.find((connection) => connection.id === linearProjectConnectionId) ?? null
              const providerConnected = Boolean(providerConnection)

              return (
                <div key={category.provider} className="space-y-2">
                  <div className="flex items-center justify-between gap-3 px-0.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold">{category.title}</p>
                        {providerConnected ? (
                          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                            Connected
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {providerConnected ? (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            data-testid={`project-${category.provider}-category-connection`}
                            onClick={() => setConnectionModalState({ provider: category.provider, mode: 'edit' })}
                            disabled={disconnectingProjectConnectionProvider === category.provider}
                          >
                            Edit connection
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            data-testid={`project-${category.provider}-category-disconnect`}
                            onClick={() => void handleDisconnectProjectConnection(category.provider)}
                            disabled={disconnectingProjectConnectionProvider === category.provider}
                          >
                            {disconnectingProjectConnectionProvider === category.provider ? 'Disconnecting\u2026' : 'Disconnect'}
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          data-testid={`project-${category.provider}-category-connection`}
                          onClick={() => setConnectionModalState({ provider: category.provider, mode: 'connect' })}
                        >
                          Connect
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    {category.items.map((item) => {
                      const isContinuousActive = item.mode === 'continuous' && activeSyncProvider === category.provider
                      const disabledByOtherProvider = item.mode === 'continuous' && Boolean(activeSyncProvider) && activeSyncProvider !== category.provider
                      const connectionReady = category.provider === 'github' ? githubConnected : linearConnected
                      const disabledByMissingConnection = !connectionReady
                      const isItemDisabled = item.disabled || disabledByMissingConnection

                      let stateLabel = ''
                      if (disabledByOtherProvider) {
                        stateLabel = activeSyncProvider === 'github' ? 'Disabled by GitHub' : 'Disabled by Linear'
                      } else if (isContinuousActive) {
                        stateLabel = 'Active'
                      } else if (disabledByMissingConnection) {
                        stateLabel = 'Connect to start using'
                      } else if (connectionReady) {
                        stateLabel = 'Connected'
                      }

                      const stateClass = isContinuousActive
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : disabledByOtherProvider
                          ? 'bg-muted text-muted-foreground'
                          : connectionReady
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : 'bg-muted/70 text-muted-foreground'
                      const hideConnectedPillForImport = item.mode === 'import' && stateLabel === 'Connected'
                      const showStatePill = Boolean(stateLabel) && !hideConnectedPillForImport

                      return (
                        <button
                          key={item.key}
                          type="button"
                          title={item.description}
                          data-testid={item.testId}
                          onClick={() => handleSelectIntegrationEntry(item.entry, { mode: item.mode })}
                          disabled={isItemDisabled}
                          className={cn(
                            'flex w-full items-center gap-3 rounded-md border p-3 text-left transition-colors hover:bg-muted/50',
                            isItemDisabled && 'cursor-not-allowed opacity-50'
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium">{item.label}</p>
                              {showStatePill ? (
                                <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', stateClass)}>
                                  {stateLabel}
                                </span>
                              ) : null}
                            </div>
                            <p className="text-xs text-muted-foreground">{item.description}</p>
                          </div>
                          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => {
                setSelectedIntegrationEntry(null)
                setSelectedIntegrationMode(null)
              }}
              className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
              {selectedIntegrationViewMeta.title}
            </button>
            {(isGithubContinuousView || isLinearContinuousView) && syncAllStepsComplete ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Sync enabled</span>
                <Switch
                  id="sync-enabled-header-toggle"
                  checked={syncSetupProvider === 'github' ? githubSyncEnabled : linearSyncEnabled}
                  disabled={switchingProvider || savingSyncProvider !== null}
                  onCheckedChange={(checked) => {
                    if (checked === true) {
                      if (syncSetupProvider === 'github') void handleSaveGithubSyncSettings()
                      else void handleSaveLinearSyncSettings()
                    } else {
                      void handleDisableSyncForProvider(syncSetupProvider!)
                    }
                  }}
                />
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">
                {selectedIntegrationViewMeta.description}
              </span>
            )}
          </div>

          {(isGithubContinuousView || isLinearContinuousView) && syncSetupProvider ? (
            <div className="space-y-3">
              {/* Not connected */}
              {(syncSetupProvider === 'github' && !githubConnected) || (syncSetupProvider === 'linear' && !linearConnected) ? (
                <Card className="gap-4 py-4">
                  <CardHeader className="px-4">
                    <CardTitle className="text-base">Connect {syncSetupProvider === 'github' ? 'GitHub' : 'Linear'}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 px-4">
                    <p className="text-sm text-muted-foreground">
                      Connect {syncSetupProvider === 'github' ? 'GitHub' : 'Linear'} from the category header to configure sync.
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <>
                  {/* Step 1: Setup */}
                  <Card className="gap-0 py-0 overflow-hidden">
                    {(syncAllStepsComplete && syncStepEditing !== 1) || (syncStep1Complete && syncStep > 1 && syncStepEditing !== 1) ? (
                      <button
                        type="button"
                        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/30 transition-colors"
                        onClick={handleSyncStepEditSetup}
                      >
                        <div className="flex items-center gap-2.5">
                          <div className="flex size-5 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
                            <Check className="size-3" />
                          </div>
                          <span className="text-sm font-medium">Setup</span>
                          <span className="text-xs text-muted-foreground">{syncStep1Summary}</span>
                        </div>
                        <Pencil className="size-3.5 text-muted-foreground" />
                      </button>
                    ) : (
                      <>
                        <div className="flex items-center justify-between px-4 pt-3 pb-4">
                          <div className="flex items-center gap-2.5">
                            <div className={cn(
                              'flex size-5 items-center justify-center rounded-full text-[11px] font-bold',
                              (syncStep === 1 || syncStepEditing === 1) ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'
                            )}>
                              1
                            </div>
                            <span className="text-sm font-medium">Setup</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {syncStepEditing === 1 ? (
                              <>
                                <Button size="sm" variant="outline" className="h-7" onClick={handleSyncStepCancelEdit}>Cancel</Button>
                                <Button
                                  size="sm"
                                  className="h-7"
                                  disabled={
                                    (syncSetupProvider === 'github' && !githubSyncProjectId) ||
                                    (syncSetupProvider === 'linear' && !linearSyncTeamId) ||
                                    savingSyncProvider !== null
                                  }
                                  onClick={() => void handleSyncStepSaveSetupEdit()}
                                >
                                  {savingSyncProvider ? (
                                    <><Loader2 className="mr-1 size-3 animate-spin" />Saving&hellip;</>
                                  ) : 'Save'}
                                </Button>
                              </>
                            ) : (
                              <Button
                                size="sm"
                                className="h-7"
                                disabled={
                                  (syncSetupProvider === 'github' && !githubSyncProjectId) ||
                                  (syncSetupProvider === 'linear' && !linearSyncTeamId) ||
                                  savingSyncProvider !== null ||
                                  loadingSyncStatuses
                                }
                                onClick={() => void handleSyncStepSetupContinue()}
                              >
                                {savingSyncProvider || loadingSyncStatuses ? (
                                  <><Loader2 className="mr-1 size-3 animate-spin" />{loadingSyncStatuses ? 'Loading\u2026' : 'Saving\u2026'}</>
                                ) : 'Continue \u2192'}
                              </Button>
                            )}
                          </div>
                        </div>
                        <CardContent className="space-y-3 px-4 pb-4">
                          {syncSetupProvider === 'github' ? (
                            <>
                              <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
                                <Label htmlFor="github-sync-project" className="text-sm">GitHub Project</Label>
                                <Select
                                  value={githubSyncProjectId || '__none__'}
                                  onValueChange={(value) => setGithubSyncProjectId(value === '__none__' ? '' : value)}
                                  disabled={!githubProjectConnectionId || loadingGithubSyncProjects}
                                >
                                  <SelectTrigger id="github-sync-project" className="w-full">
                                    <SelectValue placeholder={loadingGithubSyncProjects ? 'Loading projects\u2026' : 'Choose GitHub Project'} />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {githubSyncProjects.length === 0 ? (
                                      <SelectItem value="__none__" disabled>No GitHub Projects found</SelectItem>
                                    ) : null}
                                    {githubSyncProjects.map((projectOption) => (
                                      <SelectItem key={projectOption.id} value={projectOption.id}>
                                        {projectOption.owner.login}#{projectOption.number} - {projectOption.title}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
                                <Label htmlFor="github-sync-repo" className="text-sm">Repository</Label>
                                <Select
                                  value={githubSyncRepoFullName || '__none__'}
                                  onValueChange={(value) => setGithubSyncRepoFullName(value === '__none__' ? '' : value)}
                                  disabled={!githubProjectConnectionId || loadingGithubRepositories}
                                >
                                  <SelectTrigger id="github-sync-repo" className="w-full">
                                    <SelectValue placeholder={loadingGithubRepositories ? 'Loading repositories\u2026' : 'Choose repository'} />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {githubRepositories.length === 0 ? (
                                      <SelectItem value="__none__" disabled>No repositories found</SelectItem>
                                    ) : null}
                                    {githubRepositories.map((repo) => (
                                      <SelectItem key={repo.fullName} value={repo.fullName}>
                                        {repo.fullName}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
                                <Label htmlFor="github-sync-mode" className="text-sm">Sync mode</Label>
                                <Select value={githubSyncMode} onValueChange={(value) => setGithubSyncMode(value as IntegrationSyncMode)}>
                                  <SelectTrigger id="github-sync-mode" className="w-full">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="one_way">One-way</SelectItem>
                                    <SelectItem value="two_way">Two-way</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
                                <Label htmlFor="linear-sync-team" className="text-sm">Team</Label>
                                <Select
                                  value={linearSyncTeamId || '__none__'}
                                  onValueChange={(value) => setLinearSyncTeamId(value === '__none__' ? '' : value)}
                                  disabled={!linearProjectConnectionId || loadingLinearSyncTeams}
                                >
                                  <SelectTrigger id="linear-sync-team" className="w-full">
                                    <SelectValue placeholder={loadingLinearSyncTeams ? 'Loading teams\u2026' : 'Choose team'} />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {linearSyncTeams.length === 0 ? (
                                      <SelectItem value="__none__" disabled>No teams found</SelectItem>
                                    ) : null}
                                    {linearSyncTeams.map((team) => (
                                      <SelectItem key={team.id} value={team.id}>
                                        {team.key} - {team.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
                                <Label htmlFor="linear-sync-project" className="text-sm">Project (optional)</Label>
                                <Select
                                  value={linearSyncProjectId || '__none__'}
                                  onValueChange={(value) => setLinearSyncProjectId(value === '__none__' ? '' : value)}
                                  disabled={!linearProjectConnectionId || !linearSyncTeamId || loadingLinearSyncProjects}
                                >
                                  <SelectTrigger id="linear-sync-project" className="w-full">
                                    <SelectValue placeholder={loadingLinearSyncProjects ? 'Loading projects\u2026' : 'All team issues'} />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="__none__">All team issues</SelectItem>
                                    {linearSyncProjects.map((projectOption) => (
                                      <SelectItem key={projectOption.id} value={projectOption.id}>
                                        {projectOption.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
                                <Label htmlFor="linear-sync-mode" className="text-sm">Sync mode</Label>
                                <Select value={linearSyncMode} onValueChange={(value) => setLinearSyncMode(value as IntegrationSyncMode)}>
                                  <SelectTrigger id="linear-sync-mode" className="w-full">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="one_way">One-way</SelectItem>
                                    <SelectItem value="two_way">Two-way</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            </>
                          )}
                          {syncSettingsMessage ? (
                            <p className="text-xs text-muted-foreground">{syncSettingsMessage}</p>
                          ) : null}
                        </CardContent>
                      </>
                    )}
                  </Card>

                  {/* Step 2: Statuses (read-only) */}
                  <Card className="gap-0 py-0 overflow-hidden">
                    {syncStep2Complete && syncStep >= 3 && syncStepEditing !== 2 ? (
                      <button
                        type="button"
                        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/30 transition-colors"
                        onClick={() => { setSyncStep(2); setSyncStepEditing(2) }}
                      >
                        <div className="flex items-center gap-2.5">
                          <div className="flex size-5 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
                            <Check className="size-3" />
                          </div>
                          <span className="text-sm font-medium">Statuses</span>
                          <span className="text-xs text-muted-foreground">
                            {resolveColumns(project.columns_config).length} synced
                          </span>
                        </div>
                        <Pencil className="size-3.5 text-muted-foreground" />
                      </button>
                    ) : (syncStep >= 2 || syncStepEditing === 2) ? (
                      <>
                        <div className="flex items-center justify-between px-4 pt-3 pb-4">
                          <div className="flex items-center gap-2.5">
                            <div className={cn(
                              'flex size-5 items-center justify-center rounded-full text-[11px] font-bold',
                              (syncStep === 2 || syncStepEditing === 2) ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'
                            )}>
                              2
                            </div>
                            <span className="text-sm font-medium">Statuses</span>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7"
                            disabled={loadingSyncStatuses}
                            onClick={() => void handleSyncStepResyncStatuses()}
                          >
                            {loadingSyncStatuses ? (
                              <><Loader2 className="mr-1 size-3 animate-spin" />Checking&hellip;</>
                            ) : 'Resync'}
                          </Button>
                        </div>
                        <CardContent className="px-4 pb-4">
                          <div className="flex flex-wrap gap-1.5">
                            {resolveColumns(project.columns_config).map((col) => (
                              <span key={col.id} className="rounded bg-muted/60 px-2 py-0.5 text-xs text-foreground/80">
                                {col.label}
                              </span>
                            ))}
                          </div>
                        </CardContent>
                      </>
                    ) : (
                      <div className="flex items-center gap-2.5 px-4 py-3 opacity-50">
                        <div className="flex size-5 items-center justify-center rounded-full bg-muted text-[11px] font-bold text-muted-foreground">
                          2
                        </div>
                        <span className="text-sm font-medium text-muted-foreground">Statuses</span>
                      </div>
                    )}
                  </Card>

                  {/* Step 3: Tasks */}
                  <Card className="gap-0 py-0 overflow-hidden">
                    {syncAllStepsComplete && syncStepEditing !== 3 && syncStep !== 3 ? (
                      <button
                        type="button"
                        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/30 transition-colors"
                        onClick={() => { setSyncStep(3); setSyncStepEditing(3) }}
                      >
                        <div className="flex items-center gap-2.5">
                          <div className="flex size-5 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
                            <Check className="size-3" />
                          </div>
                          <span className="text-sm font-medium">Tasks</span>
                          <span className="text-xs text-muted-foreground">
                            {githubSummary.total || '0'} linked
                          </span>
                        </div>
                        <Pencil className="size-3.5 text-muted-foreground" />
                      </button>
                    ) : syncStep >= 3 ? (
                      <>
                        <div className="flex items-center justify-between px-4 pt-3 pb-4">
                          <div className="flex items-center gap-2.5">
                            <div className={cn(
                              'flex size-5 items-center justify-center rounded-full text-[11px] font-bold',
                              syncStep === 3 ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'
                            )}>
                              3
                            </div>
                            <span className="text-sm font-medium">Tasks</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7"
                              data-testid="github-project-check-diffs"
                              disabled={checkingGithubSync || pushingGithubSync || pullingGithubSync}
                              onClick={() => void handleCheckGithubDiffs()}
                            >
                              {checkingGithubSync ? (
                                <><Loader2 className="mr-1 size-3 animate-spin" />Checking&hellip;</>
                              ) : 'Check diffs'}
                            </Button>
                            <Button
                              size="sm"
                              className="h-7"
                              data-testid="github-project-push-local-ahead"
                              disabled={checkingGithubSync || pushingGithubSync || pullingGithubSync}
                              onClick={() => void handlePushGithubLocalAhead()}
                            >
                              {pushingGithubSync ? (
                                <><Loader2 className="mr-1 size-3 animate-spin" />Pushing&hellip;</>
                              ) : 'Push \u2191'}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7"
                              data-testid="github-project-pull-remote-ahead"
                              disabled={checkingGithubSync || pushingGithubSync || pullingGithubSync}
                              onClick={() => void handlePullGithubRemoteAhead()}
                            >
                              {pullingGithubSync ? (
                                <><Loader2 className="mr-1 size-3 animate-spin" />Pulling&hellip;</>
                              ) : 'Pull \u2193'}
                            </Button>
                            {syncSetupProvider === 'linear' ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7"
                                disabled={!linearSyncEnabled || pullingLinearSyncNow}
                                onClick={() => void handleManualLinearPull()}
                              >
                                {pullingLinearSyncNow ? (
                                  <><Loader2 className="mr-1 size-3 animate-spin" />Pulling&hellip;</>
                                ) : 'Pull now'}
                              </Button>
                            ) : null}
                          </div>
                        </div>
                        <CardContent className="space-y-2 px-4 pb-4">
                          <div className="grid grid-cols-4 gap-2">
                            <div className="rounded-md border border-border/50 bg-muted/40 px-3 py-2 text-center">
                              <p className="text-lg tabular-nums font-medium">{githubSummary.in_sync}</p>
                              <p className="text-[10px] text-muted-foreground">In sync</p>
                            </div>
                            <div className="rounded-md border border-border/50 bg-muted/40 px-3 py-2 text-center">
                              <p className="text-lg tabular-nums font-medium">{githubSummary.local_ahead}</p>
                              <p className="text-[10px] text-muted-foreground">Local ahead</p>
                            </div>
                            <div className="rounded-md border border-border/50 bg-muted/40 px-3 py-2 text-center">
                              <p className="text-lg tabular-nums font-medium">{githubSummary.remote_ahead}</p>
                              <p className="text-[10px] text-muted-foreground">Remote ahead</p>
                            </div>
                            <div className="rounded-md border border-border/50 bg-muted/40 px-3 py-2 text-center">
                              <p className="text-lg tabular-nums font-medium">{githubSummary.conflict}</p>
                              <p className="text-[10px] text-muted-foreground">Conflicts</p>
                            </div>
                          </div>

                          {githubSyncMessage ? <p className="text-xs text-muted-foreground">{githubSyncMessage}</p> : null}
                        </CardContent>
                      </>
                    ) : (
                      <div className="flex items-center gap-2.5 px-4 py-3 opacity-50">
                        <div className="flex size-5 items-center justify-center rounded-full bg-muted text-[11px] font-bold text-muted-foreground">
                          3
                        </div>
                        <span className="text-sm font-medium text-muted-foreground">Tasks</span>
                      </div>
                    )}
                  </Card>

                  {syncExternalUrlLoading ? (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" />
                      Loading...
                    </div>
                  ) : syncExternalUrl ? (
                    <button
                      type="button"
                      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => window.api.shell.openExternal(syncExternalUrl)}
                    >
                      <ExternalLinkIcon className="size-3" />
                      Open in {syncSetupProvider === 'linear' ? 'Linear' : 'GitHub'}
                    </button>
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          {isGithubImportView ? (
            <Card className="gap-4 py-4" data-testid="github-repo-import-card">
              <CardHeader className="px-4">
                <CardTitle className="text-base">Import GitHub Repository Issues</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 px-4">
                {githubConnected ? (
                  <>
                    <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                      <Label htmlFor="github-repository" className="text-sm">
                        Repository
                      </Label>
                      <Select
                        value={githubRepositoryFullName || '__none__'}
                        onValueChange={(value) => setGithubRepositoryFullName(value === '__none__' ? '' : value)}
                        disabled={!githubRepositoryConnectionId || loadingGithubRepositories}
                      >
                        <SelectTrigger id="github-repository" className="w-full max-w-md">
                          <SelectValue
                            placeholder={loadingGithubRepositories ? 'Loading repositories\u2026' : 'Choose repository'}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {githubRepositories.length === 0 ? (
                            <SelectItem value="__none__" disabled>No repositories found</SelectItem>
                          ) : null}
                          {githubRepositories.map((repository) => (
                            <SelectItem key={repository.id} value={repository.fullName}>
                              {repository.fullName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="space-y-0.5 text-xs text-muted-foreground">
                        {loadingGithubRepoIssues
                          ? 'Loading repository issues\u2026'
                          : githubRepoSortedIssues.length > 0
                            ? githubRepoIssueQueryNormalized
                              ? `${githubRepoFilteredIssues.length} of ${githubRepoSortedIssues.length} issues shown`
                              : `${githubRepoSortedIssues.length} issues loaded`
                            : 'Load repository issues to import selected tasks'}
                        {githubRepoSortedIssues.length > 0 ? (
                          <p>
                            {githubRepoImportableIssues.length} importable
                            {githubRepoLinkedInProjectCount > 0 ? ` \u2022 ${githubRepoLinkedInProjectCount} linked here` : ''}
                            {githubRepoLinkedElsewhereCount > 0 ? ` \u2022 ${githubRepoLinkedElsewhereCount} linked elsewhere` : ''}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          data-testid="github-repo-load-issues"
                          disabled={!canLoadGithubRepoIssues || loadingGithubRepoIssues}
                          onClick={handleLoadGithubRepositoryIssues}
                        >
                          {loadingGithubRepoIssues ? 'Loading\u2026' : githubRepoSortedIssues.length > 0 ? 'Refresh issues' : 'Load issues'}
                        </Button>
                        {githubRepoVisibleImportableIssues.length > 0 ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              if (allVisibleGithubRepoIssuesSelected) {
                                setSelectedGithubRepoIssueIds((previous) => {
                                  const next = new Set(previous)
                                  for (const issue of githubRepoVisibleImportableIssues) {
                                    next.delete(issue.id)
                                  }
                                  return next
                                })
                                return
                              }
                              setSelectedGithubRepoIssueIds((previous) => {
                                const next = new Set(previous)
                                for (const issue of githubRepoVisibleImportableIssues) {
                                  next.add(issue.id)
                                }
                                return next
                              })
                            }}
                          >
                            {allVisibleGithubRepoIssuesSelected ? 'Clear visible' : 'Select visible'}
                          </Button>
                        ) : null}
                      </div>
                    </div>

                    <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                      <Label htmlFor="github-repo-issue-filter" className="text-sm">
                        Filter issues
                      </Label>
                      <Input
                        id="github-repo-issue-filter"
                        value={githubRepoIssueQuery}
                        onChange={(event) => setGithubRepoIssueQuery(event.target.value)}
                        placeholder="Search by #number, title, or repository"
                        className="w-full max-w-md"
                      />
                    </div>

                    <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                      <Label htmlFor="github-repo-issue-sort" className="text-sm">
                        Sort by
                      </Label>
                      <Select
                        value={githubImportSort}
                        onValueChange={(value) => setGithubImportSort(value as ImportIssueSort)}
                      >
                        <SelectTrigger id="github-repo-issue-sort" className="w-full max-w-md">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="updated_desc">Recently updated</SelectItem>
                          <SelectItem value="updated_asc">Least recently updated</SelectItem>
                          <SelectItem value="title_asc">Title A-Z</SelectItem>
                          <SelectItem value="title_desc">Title Z-A</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="min-h-40 rounded border p-2">
                      {githubRepoFilteredIssues.length > 0 ? (
                        <div className="max-h-44 space-y-1 overflow-y-auto">
                          {githubRepoFilteredIssues.map((issue) =>
                            issue.linkedTaskId ? (
                              <div key={issue.id} className="flex items-start gap-2 rounded px-1 py-0.5 text-xs opacity-60">
                                {issue.linkedProjectId === project.id ? (
                                  <span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                    Linked
                                  </span>
                                ) : (
                                  <span className="mt-0.5 shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                                    Linked elsewhere
                                  </span>
                                )}
                                <span className="min-w-0">
                                  <span className="font-medium">{issue.repository.fullName}#{issue.number}</span>
                                  {' - '}
                                  <span className="text-muted-foreground">{issue.title}</span>
                                  {issue.linkedProjectId && issue.linkedProjectId !== project.id ? (
                                    <span className="block text-[10px] text-muted-foreground">
                                      {issue.linkedProjectName
                                        ? `Already linked in ${issue.linkedProjectName}`
                                        : 'Already linked in another project'}
                                    </span>
                                  ) : null}
                                </span>
                              </div>
                            ) : (
                              <label key={issue.id} className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted/50">
                                <Checkbox
                                  checked={selectedGithubRepoIssueIds.has(issue.id)}
                                  onCheckedChange={(checked) => toggleGithubRepoIssue(issue.id, checked === true)}
                                />
                                <span className="min-w-0">
                                  <span className="font-medium">{issue.repository.fullName}#{issue.number}</span>
                                  {' - '}
                                  <span className="text-muted-foreground">{issue.title}</span>
                                </span>
                              </label>
                            )
                          )}
                        </div>
                      ) : (
                        <div className="flex h-full min-h-36 items-center justify-center text-xs text-muted-foreground">
                          {githubRepoSortedIssues.length > 0
                            ? 'No issues match the current filter.'
                            : 'No loaded repository issues yet.'}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground">
                        {selectedGithubRepoImportableCount > 0
                          ? `${selectedGithubRepoImportableCount} selected`
                          : githubRepoImportableIssues.length > 0
                            ? `${githubRepoImportableIssues.length} importable issues available`
                            : 'No importable issues in the loaded set'}
                      </p>
                      <Button
                        size="sm"
                        data-testid="github-repo-import-issues"
                        disabled={!canImportGithubRepoIssues || importingGithubRepoIssues}
                        onClick={handleImportGithubRepositoryIssues}
                      >
                        {importingGithubRepoIssues
                          ? 'Importing\u2026'
                          : selectedGithubRepoImportableCount > 0
                            ? `Import selected (${selectedGithubRepoImportableCount})`
                            : githubRepoSortedIssues.length > 0
                              ? `Import all importable (${githubRepoImportableIssues.length})`
                              : 'Import repository issues'}
                      </Button>
                    </div>

                    {githubRepoImportMessage ? (
                      <p className="text-xs text-muted-foreground">{githubRepoImportMessage}</p>
                    ) : null}
                  </>
                ) : (
                  <div className="rounded-md border border-dashed p-3">
                    <p className="text-sm text-muted-foreground">
                      No GitHub connection is configured for this project. Connect one first.
                    </p>
                    <div className="mt-3 flex justify-end">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setConnectionModalState({ provider: 'github', mode: 'connect' })}
                      >
                        Open connection settings
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ) : null}

          {isLinearImportView ? (
            <Card className="gap-4 py-4">
              <CardHeader className="px-4">
                <CardTitle className="text-base">Import Issues</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 px-4">
                {linearConnected ? (
                  <>
                    <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                      <Label htmlFor="linear-import-team" className="text-sm">
                        Team
                      </Label>
                      <Select
                        value={linearImportTeamId || '__none__'}
                        onValueChange={(value) => setLinearImportTeamId(value === '__none__' ? '' : value)}
                        disabled={!linearProjectConnectionId || loadingLinearImportTeams}
                      >
                        <SelectTrigger id="linear-import-team" className="w-full max-w-md">
                          <SelectValue placeholder={loadingLinearImportTeams ? 'Loading teams\u2026' : 'Choose team'} />
                        </SelectTrigger>
                        <SelectContent>
                          {linearImportTeams.length === 0 ? (
                            <SelectItem value="__none__" disabled>No teams found</SelectItem>
                          ) : null}
                          {linearImportTeams.map((team) => (
                            <SelectItem key={team.id} value={team.id}>
                              {team.key} - {team.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                      <Label htmlFor="linear-import-project" className="text-sm">
                        Project (optional)
                      </Label>
                      <Select
                        value={linearImportProjectId || '__none__'}
                        onValueChange={(value) => setLinearImportProjectId(value === '__none__' ? '' : value)}
                        disabled={!linearProjectConnectionId || !linearImportTeamId || loadingLinearImportProjects}
                      >
                        <SelectTrigger id="linear-import-project" className="w-full max-w-md">
                          <SelectValue placeholder={loadingLinearImportProjects ? 'Loading projects\u2026' : 'All team issues'} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">All team issues</SelectItem>
                          {linearImportProjects.map((projectOption) => (
                            <SelectItem key={projectOption.id} value={projectOption.id}>
                              {projectOption.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {linearImportSourceMessage ? (
                      <p className="text-xs text-muted-foreground">{linearImportSourceMessage}</p>
                    ) : null}

                    <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                      <Label htmlFor="linear-import-sort" className="text-sm">
                        Sort by
                      </Label>
                      <Select
                        value={linearImportSort}
                        onValueChange={(value) => setLinearImportSort(value as ImportIssueSort)}
                      >
                        <SelectTrigger id="linear-import-sort" className="w-full max-w-md">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="updated_desc">Recently updated</SelectItem>
                          <SelectItem value="updated_asc">Least recently updated</SelectItem>
                          <SelectItem value="title_asc">Title A-Z</SelectItem>
                          <SelectItem value="title_desc">Title Z-A</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs text-muted-foreground">
                        {loadingIssues
                          ? 'Loading issues\u2026'
                          : sortedLinearIssueOptions.length > 0
                            ? `${sortedLinearIssueOptions.length} issues loaded`
                            : 'Load issues from Linear to import specific tasks'}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!canLoadIssues || loadingIssues}
                          onClick={handleLoadIssues}
                        >
                          {loadingIssues ? 'Loading\u2026' : 'Load issues'}
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
                      {sortedLinearIssueOptions.length > 0 ? (
                        <div className="max-h-44 space-y-1 overflow-y-auto">
                          {sortedLinearIssueOptions.map((issue) =>
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
                          ? 'Importing\u2026'
                          : selectedIssueIds.size > 0
                            ? `Import selected (${selectedIssueIds.size})`
                            : sortedLinearIssueOptions.length > 0
                              ? 'Import all loaded'
                              : 'Import from Linear'}
                      </Button>
                    </div>

                    {importMessage ? (
                      <p className="text-xs text-muted-foreground">{importMessage}</p>
                    ) : null}
                  </>
                ) : (
                  <div className="rounded-md border border-dashed p-3">
                    <p className="text-sm text-muted-foreground">
                      No Linear connection is configured for this project. Connect one first.
                    </p>
                    <div className="mt-3 flex justify-end">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setConnectionModalState({ provider: 'linear', mode: 'connect' })}
                      >
                        Open connection settings
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}

      {connectionModalState ? (
        <ProjectIntegrationConnectionModal
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              setConnectionModalState(null)
            }
          }}
          projectId={project.id}
          provider={connectionModalState.provider}
          mode={connectionModalState.mode}
          connectionId={connectionModalState.provider === 'github' ? githubProjectConnectionId : linearProjectConnectionId}
          onConnectionsChanged={reloadIntegrationState}
        />
      ) : null}
    </div>
  )
}
