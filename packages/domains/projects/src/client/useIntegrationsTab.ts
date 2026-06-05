import { useState, useEffect, useCallback } from 'react'
import { toast } from '@slayzone/ui'
import type {
  GithubIssueSummary,
  GithubProjectSummary,
  IntegrationProvider,
  GithubRepositorySummary,
  IntegrationConnectionPublic,
  IntegrationProjectMapping,
  IntegrationSyncMode,
  LinearIssueSummary,
  LinearProject,
  LinearTeam
} from '@slayzone/integrations/shared'
import { providerDisplayName } from './project-settings-shared'
import type {
  ImportIssueSort,
  IntegrationsTabProps,
  IntegrationSetupEntry,
  ProjectSyncSummary,
  TaskSyncRow
} from './IntegrationsTab.types'
import { formatGithubImportMessage, sortByMode, summarizeSyncRows } from './IntegrationsTab.utils'

export function useIntegrationsTab({
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
  const [linearAssignedToMe, setLinearAssignedToMe] = useState(false)
  const [selectedIssueIds, setSelectedIssueIds] = useState<Set<string>>(new Set())
  const [loadingIssues, setLoadingIssues] = useState(false)
  const [githubRepoIssueOptions, setGithubRepoIssueOptions] = useState<GithubIssueSummary[]>([])
  const [githubImportSort, setGithubImportSort] = useState<ImportIssueSort>('updated_desc')
  const [selectedGithubRepoIssueIds, setSelectedGithubRepoIssueIds] = useState<Set<string>>(
    new Set()
  )
  const [githubRepoIssueQuery, setGithubRepoIssueQuery] = useState('')
  const [loadingGithubRepoIssues, setLoadingGithubRepoIssues] = useState(false)
  const [importingGithubRepoIssues, setImportingGithubRepoIssues] = useState(false)
  const [githubRepoImportMessage, setGithubRepoImportMessage] = useState('')
  const [syncRows, setSyncRows] = useState<TaskSyncRow[]>([])
  const [syncSummary, setSyncSummary] = useState<ProjectSyncSummary | null>(null)
  const [checkingSync, setCheckingSync] = useState(false)
  const [pushingSync, setPushingSync] = useState(false)
  const [pullingSync, setPullingSync] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')
  const [selectedIntegrationEntry, setSelectedIntegrationEntry] =
    useState<IntegrationSetupEntry | null>(null)
  const [selectedIntegrationMode, setSelectedIntegrationMode] = useState<
    'continuous' | 'import' | null
  >(integrationOnboardingProvider ? 'continuous' : null)
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
  const [linearSyncAssignedToMe, setLinearSyncAssignedToMe] = useState(false)
  const [syncSettingsMessage, setSyncSettingsMessage] = useState('')
  const [savingSyncProvider, setSavingSyncProvider] = useState<IntegrationProvider | null>(null)
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
  const [disconnectingProjectConnectionProvider, setDisconnectingProjectConnectionProvider] =
    useState<IntegrationProvider | null>(null)
  const [switchingProvider, setSwitchingProvider] = useState(false)
  const [syncStep, setSyncStep] = useState<1 | 2 | 3>(1)
  const [syncStepEditing, setSyncStepEditing] = useState<1 | 2 | 3 | null>(null)
  const [loadingSyncStatuses, setLoadingSyncStatuses] = useState(false)

  useEffect(() => {
    if (open) {
      setSelectedIntegrationEntry(null)
      setSelectedIntegrationMode(null)
    }
  }, [open, project.id])

  useEffect(() => {
    if (!open) return
    if (!integrationOnboardingProvider) return
    setSelectedIntegrationEntry(
      integrationOnboardingProvider === 'github' ? 'github_projects' : 'linear'
    )
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
    const resolvedGithubConnectionId =
      loadedGithubProjectConnectionId &&
      loadedGithubConnections.some(
        (connection) => connection.id === loadedGithubProjectConnectionId
      )
        ? loadedGithubProjectConnectionId
        : loadedGithubMapping?.connection_id &&
            loadedGithubConnections.some(
              (connection) => connection.id === loadedGithubMapping.connection_id
            )
          ? loadedGithubMapping.connection_id
          : ''
    const resolvedLinearConnectionId =
      loadedLinearProjectConnectionId &&
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
    setLinearSyncAssignedToMe(Boolean(loadedMapping?.assigned_to_me))
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
    setSyncRows([])
    setSyncSummary(null)
    setSyncMessage('')
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
  }, [
    selectedIntegrationEntry,
    githubProjectConnectionId,
    githubMapping?.connection_id,
    githubRepositoryFullName
  ])

  useEffect(() => {
    if (!githubProjectConnectionId) {
      setGithubSyncProjects([])
      setGithubSyncProjectId('')
      return
    }
    setLoadingGithubSyncProjects(true)
    setSyncSettingsMessage('')
    void window.api.integrations
      .listGithubProjects(githubProjectConnectionId)
      .then((projects) => {
        setGithubSyncProjects(projects)
        setGithubSyncProjectId((current) => {
          if (current && projects.some((projectOption) => projectOption.id === current))
            return current
          if (
            githubMapping?.external_project_id &&
            projects.some((projectOption) => projectOption.id === githubMapping.external_project_id)
          ) {
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
    void window.api.integrations
      .listLinearTeams(linearProjectConnectionId)
      .then((result) => {
        const teams = Array.isArray(result) ? result : result.teams
        setLinearSyncTeams(teams)
        if (!Array.isArray(result)) setLinearOrgUrlKey(result.orgUrlKey)
        setLinearSyncTeamId((current) => {
          if (current && teams.some((team) => team.id === current)) return current
          if (
            mapping?.external_team_id &&
            teams.some((team) => team.id === mapping.external_team_id)
          ) {
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
    void window.api.integrations
      .listLinearProjects(linearProjectConnectionId, linearSyncTeamId)
      .then((projects) => {
        setLinearSyncProjects(projects)
        setLinearSyncProjectId((current) => {
          if (current && projects.some((projectOption) => projectOption.id === current))
            return current
          if (
            mapping?.external_project_id &&
            projects.some((projectOption) => projectOption.id === mapping.external_project_id)
          ) {
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
    void window.api.integrations
      .listLinearTeams(linearProjectConnectionId)
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
    void window.api.integrations
      .listLinearProjects(linearProjectConnectionId, linearImportTeamId)
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
    const confirmed = window.confirm(
      `Disconnect ${providerDisplayName(provider)} for this project?`
    )
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
    const selectedProject = githubSyncProjects.find(
      (projectOption) => projectOption.id === githubSyncProjectId
    )
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
        syncMode: linearSyncMode,
        assignedToMe: linearSyncAssignedToMe
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

      if (
        !window.confirm(
          `This will replace your board columns with ${statuses.length} statuses from ${providerDisplayName(provider)}. Continue?`
        )
      ) {
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
      ]
        .filter(Boolean)
        .join(', ')
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
        assignedToMe: linearAssignedToMe || undefined,
        limit: 50
      })
      setIssueOptions(result.issues)
      const importableIds = new Set(result.issues.filter((i) => !i.linkedTaskId).map((i) => i.id))
      setSelectedIssueIds(
        (previous) => new Set([...previous].filter((id) => importableIds.has(id)))
      )
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
      const importableIds = new Set(
        result.issues.filter((issue) => !issue.linkedTaskId).map((issue) => issue.id)
      )
      setSelectedGithubRepoIssueIds(
        (previous) => new Set([...previous].filter((id) => importableIds.has(id)))
      )
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
      const selectedImportableIds = [...selectedGithubRepoIssueIds].filter((id) =>
        importableIdSet.has(id)
      )
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
        await Promise.all([handleLoadGithubRepositoryIssues(), collectSyncRows()])
      }
    } catch (error) {
      setGithubRepoImportMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setImportingGithubRepoIssues(false)
    }
  }

  const syncSetupProvider: IntegrationProvider | null =
    selectedIntegrationEntry === 'linear'
      ? 'linear'
      : selectedIntegrationEntry === 'github_projects'
        ? 'github'
        : selectedIntegrationEntry === 'jira'
          ? 'jira'
          : null

  const collectSyncRows = async (): Promise<TaskSyncRow[]> => {
    const provider = syncSetupProvider
    if (!provider) return []

    const tasks = await window.api.db.getTasksByProject(project.id)
    const taskIds = tasks.map((t) => t.id)

    // Single batch call: returns link + status for all tasks
    const batchItems = await window.api.integrations.getBatchTaskSyncStatus(taskIds, provider)
    const itemByTaskId = new Map(batchItems.map((item) => [item.taskId, item]))

    const rows: TaskSyncRow[] = taskIds.map((taskId) => {
      const item = itemByTaskId.get(taskId)
      if (!item || !item.link) return { taskId, link: null, status: null }
      return { taskId, link: item.link, status: item.status }
    })

    setSyncRows(rows)
    setSyncSummary(summarizeSyncRows(rows))
    return rows
  }

  const handleCheckDiffs = async () => {
    setCheckingSync(true)
    setSyncMessage('')
    try {
      const rows = await collectSyncRows()
      const linked = rows.filter((r) => r.link).length
      const unlinked = rows.filter((r) => !r.link).length
      setSyncMessage(
        `Checked ${linked} linked${unlinked > 0 ? ` + ${unlinked} unlinked` : ''} tasks`
      )
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setCheckingSync(false)
    }
  }

  const handlePushLocalAhead = async () => {
    if (!syncSetupProvider) return
    setPushingSync(true)
    setSyncMessage('')
    try {
      const rows = syncRows.length > 0 ? syncRows : await collectSyncRows()

      // Push linked local-ahead tasks
      const targets = rows.filter((row) => row.link && row.status?.state === 'local_ahead')
      let pushed = 0
      let skipped = 0
      let errors = 0
      for (const target of targets) {
        try {
          const result = await window.api.integrations.pushTask({
            taskId: target.taskId,
            provider: syncSetupProvider
          })
          if (result.pushed) pushed += 1
          else skipped += 1
        } catch {
          errors += 1
        }
      }

      // Push unlinked tasks
      const unlinkedCount = rows.filter((r) => !r.link).length
      let unlinkedPushed = 0
      if (unlinkedCount > 0) {
        const result = await window.api.integrations.pushUnlinkedTasks({
          projectId: project.id,
          provider: syncSetupProvider
        })
        unlinkedPushed = result.pushed
        errors += result.errors.length
      }

      if (pushed > 0 || unlinkedPushed > 0) {
        ;(window as any).__slayzone_refreshData?.()
      }
      const parts = [`${pushed} pushed`, `${skipped} skipped`]
      if (unlinkedPushed > 0) parts.push(`${unlinkedPushed} newly linked`)
      if (errors > 0) parts.push(`${errors} errors`)
      setSyncMessage(`Push complete: ${parts.join(', ')}`)
      await collectSyncRows()
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setPushingSync(false)
    }
  }

  const handlePullRemoteAhead = async () => {
    if (!syncSetupProvider) return
    setPullingSync(true)
    setSyncMessage('')
    try {
      const rows = syncRows.length > 0 ? syncRows : await collectSyncRows()
      const targets = rows.filter((row) => row.link && row.status?.state === 'remote_ahead')
      if (targets.length === 0) {
        setSyncMessage('No remote-ahead tasks to pull')
        return
      }

      let pulled = 0
      let skipped = 0
      let errors = 0
      for (const target of targets) {
        try {
          const result = await window.api.integrations.pullTask({
            taskId: target.taskId,
            provider: syncSetupProvider
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
      setSyncMessage(
        `Pull complete: ${pulled} pulled, ${skipped} skipped${errors > 0 ? `, ${errors} errors` : ''}`
      )
      await collectSyncRows()
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setPullingSync(false)
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
  const isGithubContinuousView =
    selectedIntegrationEntry === 'github_projects' && selectedIntegrationMode === 'continuous'
  const isGithubImportView =
    selectedIntegrationEntry === 'github_issues' && selectedIntegrationMode === 'import'
  const isLinearContinuousView =
    selectedIntegrationEntry === 'linear' && selectedIntegrationMode === 'continuous'
  const isLinearImportView =
    selectedIntegrationEntry === 'linear' && selectedIntegrationMode === 'import'
  const isJiraContinuousView =
    selectedIntegrationEntry === 'jira' && selectedIntegrationMode === 'continuous'
  const isJiraImportView =
    selectedIntegrationEntry === 'jira' && selectedIntegrationMode === 'import'
  const activeSyncProvider: IntegrationProvider | null = linearMappingSource
    ? 'linear'
    : githubMappingSource
      ? 'github'
      : null
  const githubSyncEnabled = Boolean(githubMappingSource)
  const linearSyncEnabled = Boolean(linearMappingSource)
  const githubConnected = Boolean(githubProjectConnectionId)
  const linearConnected = Boolean(linearProjectConnectionId)
  const syncCurrentMapping =
    syncSetupProvider === 'linear' ? linearMappingSource : githubMappingSource
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
      const teamKey =
        linearSyncTeams.find((t) => t.id === syncCurrentMapping.external_team_id)?.key ??
        syncCurrentMapping.external_team_key
      return `https://linear.app/${linearOrgUrlKey}/team/${teamKey}`
    }
    const proj = githubSyncProjects.find((p) => p.id === syncCurrentMapping.external_project_id)
    return proj?.url ?? null
  })()

  const syncExternalUrlLoading = Boolean(
    syncCurrentMapping &&
      !syncExternalUrl &&
      (syncSetupProvider === 'linear' ? loadingLinearSyncTeams : loadingGithubSyncProjects)
  )

  const githubProjectsDisabled = activeSyncProvider === 'linear'
  const linearDisabled = activeSyncProvider === 'github'
  const githubRepositoryConnectionId =
    githubProjectConnectionId || githubMappingSource?.connection_id || ''
  const linearIssueConnectionId = linearProjectConnectionId
  const linearIssueTeamId = linearImportTeamId
  const canLoadIssues = Boolean(linearIssueConnectionId && linearIssueTeamId)
  const canImportIssues = Boolean(linearIssueConnectionId && linearIssueTeamId)
  const sortedLinearIssueOptions = sortByMode(issueOptions, linearImportSort)
  const importableIssues = sortedLinearIssueOptions.filter((i) => !i.linkedTaskId)
  const allVisibleIssuesSelected =
    importableIssues.length > 0 && selectedIssueIds.size === importableIssues.length
  const canLoadGithubRepoIssues = Boolean(githubRepositoryConnectionId && githubRepositoryFullName)
  const githubRepoIssueQueryNormalized = githubRepoIssueQuery.trim().toLowerCase()
  const githubRepoSortedIssues = sortByMode(githubRepoIssueOptions, githubImportSort)
  const githubRepoFilteredIssues = githubRepoIssueQueryNormalized
    ? githubRepoSortedIssues.filter((issue) =>
        `${issue.repository.fullName}#${issue.number} ${issue.title}`
          .toLowerCase()
          .includes(githubRepoIssueQueryNormalized)
      )
    : githubRepoSortedIssues
  const githubRepoImportableIssues = githubRepoSortedIssues.filter((issue) => !issue.linkedTaskId)
  const githubRepoVisibleImportableIssues = githubRepoFilteredIssues.filter(
    (issue) => !issue.linkedTaskId
  )
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
      (githubRepoSortedIssues.length === 0 ||
        githubRepoImportableIssues.length > 0 ||
        selectedGithubRepoImportableCount > 0)
  )
  const allVisibleGithubRepoIssuesSelected =
    githubRepoVisibleImportableIssues.length > 0 &&
    githubRepoVisibleImportableIssues.every((issue) => selectedGithubRepoIssueIds.has(issue.id))
  const taskSyncSummary = syncSummary ?? {
    total: 0,
    in_sync: 0,
    local_ahead: 0,
    remote_ahead: 0,
    conflict: 0,
    unknown: 0,
    unlinked: 0,
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
    },
    {
      provider: 'jira' as const,
      title: 'Jira',
      items: [
        {
          key: 'jira-continuous-sync',
          entry: 'jira' as IntegrationSetupEntry,
          mode: 'continuous' as const,
          label: 'Continuous sync',
          description: 'Sync with a Jira Cloud project.',
          disabled: switchingProvider,
          testId: 'project-integration-provider-jira'
        },
        {
          key: 'jira-one-time-import',
          entry: 'jira' as IntegrationSetupEntry,
          mode: 'import' as const,
          label: 'One-time import',
          description: 'Import Jira issues once.',
          disabled: switchingProvider,
          testId: 'project-integration-provider-jira-import'
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
    if (isJiraContinuousView) {
      return {
        title: 'Jira - Continuous sync',
        description: 'Set up and run continuous sync with a Jira Cloud project.'
      }
    }
    if (isJiraImportView) {
      return {
        title: 'Jira - One-time import',
        description: 'Import Jira issues once into this project.'
      }
    }
    return {
      title: 'Integrations',
      description: 'Choose an integration item to continue.'
    }
  })()

  return {
    activeSyncProvider,
    integrationCategoryItems,
    syncSetupProvider,
    allVisibleGithubRepoIssuesSelected,
    allVisibleIssuesSelected,
    canImportGithubRepoIssues,
    canImportIssues,
    canLoadGithubRepoIssues,
    canLoadIssues,
    checkingSync,
    collectSyncRows,
    connectionModalState,
    connections,
    disconnectingProjectConnectionProvider,
    githubConnected,
    githubConnections,
    githubImportSort,
    githubMapping,
    githubMappingSource,
    githubProjectConnectionId,
    githubProjectsDisabled,
    githubRepoFilteredIssues,
    githubRepoImportMessage,
    githubRepoImportableIdSet,
    githubRepoImportableIssues,
    githubRepoIssueOptions,
    githubRepoIssueQuery,
    githubRepoIssueQueryNormalized,
    githubRepoLinkedElsewhereCount,
    githubRepoLinkedInProjectCount,
    githubRepoSortedIssues,
    githubRepoVisibleImportableIssues,
    githubRepositories,
    githubRepositoryConnectionId,
    githubRepositoryFullName,
    githubSyncEnabled,
    githubSyncMode,
    githubSyncProjectId,
    githubSyncProjects,
    githubSyncRepoFullName,
    handleCheckDiffs,
    handleDisableSyncForProvider,
    handleDisconnectProjectConnection,
    handleImportGithubRepositoryIssues,
    handleImportIssues,
    handleLoadGithubRepositoryIssues,
    handleLoadIssues,
    handlePullRemoteAhead,
    handlePushLocalAhead,
    handleSaveGithubSyncSettings,
    handleSaveLinearSyncSettings,
    handleSelectIntegrationEntry,
    handleSyncStepCancelEdit,
    handleSyncStepEditSetup,
    handleSyncStepResyncStatuses,
    handleSyncStepSaveSetupEdit,
    handleSyncStepSetupContinue,
    importMessage,
    importableIssues,
    importing,
    importingGithubRepoIssues,
    isGithubContinuousView,
    isGithubImportView,
    isJiraContinuousView,
    isJiraImportView,
    isLinearContinuousView,
    isLinearImportView,
    issueOptions,
    linearAssignedToMe,
    linearConnected,
    linearDisabled,
    linearImportProjectId,
    linearImportProjects,
    linearImportSort,
    linearImportSourceMessage,
    linearImportTeamId,
    linearImportTeams,
    linearIssueConnectionId,
    linearIssueTeamId,
    linearMappingSource,
    linearOrgUrlKey,
    linearProjectConnectionId,
    linearSyncAssignedToMe,
    linearSyncEnabled,
    linearSyncMode,
    linearSyncProjectId,
    linearSyncProjects,
    linearSyncTeamId,
    linearSyncTeams,
    loadingGithubRepoIssues,
    loadingGithubRepositories,
    loadingGithubSyncProjects,
    loadingIssues,
    loadingLinearImportProjects,
    loadingLinearImportTeams,
    loadingLinearSyncProjects,
    loadingLinearSyncTeams,
    loadingSyncStatuses,
    mapping,
    project,
    pullingSync,
    pushingSync,
    reloadIntegrationState,
    savingSyncProvider,
    selectedGithubRepoImportableCount,
    selectedGithubRepoIssueIds,
    selectedIntegrationEntry,
    selectedIntegrationMode,
    selectedIntegrationViewMeta,
    selectedIssueIds,
    setCheckingSync,
    setConnectionModalState,
    setConnections,
    setDisconnectingProjectConnectionProvider,
    setGithubConnections,
    setGithubImportSort,
    setGithubMapping,
    setGithubProjectConnectionId,
    setGithubRepoImportMessage,
    setGithubRepoIssueOptions,
    setGithubRepoIssueQuery,
    setGithubRepositories,
    setGithubRepositoryFullName,
    setGithubSyncMode,
    setGithubSyncProjectId,
    setGithubSyncProjects,
    setGithubSyncRepoFullName,
    setImportMessage,
    setImporting,
    setImportingGithubRepoIssues,
    setIssueOptions,
    setLinearAssignedToMe,
    setLinearImportProjectId,
    setLinearImportProjects,
    setLinearImportSort,
    setLinearImportSourceMessage,
    setLinearImportTeamId,
    setLinearImportTeams,
    setLinearOrgUrlKey,
    setLinearProjectConnectionId,
    setLinearSyncAssignedToMe,
    setLinearSyncMode,
    setLinearSyncProjectId,
    setLinearSyncProjects,
    setLinearSyncTeamId,
    setLinearSyncTeams,
    setLoadingGithubRepoIssues,
    setLoadingGithubRepositories,
    setLoadingGithubSyncProjects,
    setLoadingIssues,
    setLoadingLinearImportProjects,
    setLoadingLinearImportTeams,
    setLoadingLinearSyncProjects,
    setLoadingLinearSyncTeams,
    setLoadingSyncStatuses,
    setMapping,
    setPullingSync,
    setPushingSync,
    setSavingSyncProvider,
    setSelectedGithubRepoIssueIds,
    setSelectedIntegrationEntry,
    setSelectedIntegrationMode,
    setSelectedIssueIds,
    setSwitchingProvider,
    setSyncMessage,
    setSyncRows,
    setSyncSettingsMessage,
    setSyncStep,
    setSyncStepEditing,
    setSyncSummary,
    sortedLinearIssueOptions,
    switchingProvider,
    syncAllStepsComplete,
    syncCurrentMapping,
    syncExternalUrl,
    syncExternalUrlLoading,
    syncMessage,
    syncRows,
    syncSettingsMessage,
    syncStep,
    syncStep1Complete,
    syncStep1Summary,
    syncStep2Complete,
    syncStepEditing,
    syncSummary,
    taskSyncSummary,
    toggleGithubRepoIssue,
    toggleIssue
  }
}

export type IntegrationsTabModel = ReturnType<typeof useIntegrationsTab>
