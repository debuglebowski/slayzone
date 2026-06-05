import { useCallback, useEffect, useMemo, useState } from 'react'
import { resolveColumns } from '@slayzone/projects/shared'
import { type WorkflowCategory } from '@slayzone/workflow'
import {
  type GithubProjectSummary,
  type IntegrationConnectionPublic,
  type IntegrationProjectMapping,
  type LinearProject,
  type LinearTeam,
  type ProviderStatus
} from '@slayzone/integrations/shared'
import type {
  ProjectIntegrationSetupWizardProps,
  WizardSyncMode
} from './ProjectIntegrationSetupWizard.types'
import { SYNC_MODE_OPTIONS } from './ProjectIntegrationSetupWizard.constants'
import {
  providerConnectionLabel,
  toPersistedSyncMode,
  toWizardSyncMode
} from './ProjectIntegrationSetupWizard.helpers'

export function useProjectIntegrationSetupWizard({
  project,
  provider,
  initialConnectionId,
  connectionLocked = false,
  initialTeamId,
  initialLinearProjectId,
  initialSyncMode,
  initialAssignedToMe,
  onCompleted
}: ProjectIntegrationSetupWizardProps) {
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
  const [assignedToMe, setAssignedToMe] = useState(initialAssignedToMe ?? false)
  const [conflictPolicy, setConflictPolicy] = useState<'external' | 'local' | 'latest' | 'manual'>(
    'external'
  )
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

  const mappedStatuses = useMemo(
    () => resolveColumns(project.columns_config),
    [project.columns_config]
  )
  const openStatusLabel = useMemo(
    () =>
      mappedStatuses.find(
        (column) =>
          column.category === 'unstarted' ||
          column.category === 'triage' ||
          column.category === 'backlog'
      )?.label ??
      mappedStatuses[0]?.label ??
      'Default',
    [mappedStatuses]
  )
  const closedStatusLabel = useMemo(
    () =>
      mappedStatuses.find(
        (column) => column.category === 'completed' || column.category === 'canceled'
      )?.label ??
      mappedStatuses[mappedStatuses.length - 1]?.label ??
      'Done',
    [mappedStatuses]
  )

  const selectedGitHubProject = useMemo(
    () => githubProjects.find((githubProject) => githubProject.id === githubProjectId) ?? null,
    [githubProjects, githubProjectId]
  )

  const loadConnections = useCallback(
    async (options?: { preserveMessage?: boolean }) => {
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
    },
    [provider, connectionLocked, initialConnectionId]
  )

  useEffect(() => {
    setStep(1)
    setMessage('')
    setConnectionId(initialConnectionId ?? '')
    setTeamId(initialTeamId ?? '')
    setLinearProjectId(initialLinearProjectId ?? '')
    setGithubProjectId('')
    setSyncMode(toWizardSyncMode(initialSyncMode))
    setAssignedToMe(initialAssignedToMe ?? false)
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
  }, [
    provider,
    initialConnectionId,
    initialTeamId,
    initialLinearProjectId,
    initialSyncMode,
    initialAssignedToMe,
    project.id
  ])

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
    void window.api.integrations
      .listLinearTeams(connectionId)
      .then((result) => {
        const loadedTeams = Array.isArray(result) ? result : result.teams
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
    void window.api.integrations
      .listLinearProjects(connectionId, teamId)
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
    void window.api.integrations
      .listGithubProjects(connectionId)
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
  const sourceKey =
    provider === 'linear'
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
    const externalProjectId =
      provider === 'github' ? selectedGitHubProject?.id : linearProjectId || undefined
    if (!externalTeamId) return

    setLoadingStatuses(true)
    void window.api.integrations
      .fetchProviderStatuses({
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
  }, [
    step,
    connectionId,
    provider,
    teamId,
    selectedGitHubProject,
    linearProjectId,
    providerStatuses.length
  ])

  const handleApplyStatuses = async () => {
    setApplyingStatuses(true)
    setMessage('')
    try {
      await window.api.integrations.applyStatusSync({
        projectId: project.id,
        provider,
        statuses: providerStatuses,
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

    const request = window.api.integrations.listProviderIssues({
      connectionId,
      projectId: project.id,
      groupId: provider === 'linear' ? teamId : undefined,
      scopeId: provider === 'linear' ? linearProjectId || undefined : selectedGitHubProject?.id,
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
        syncMode: toPersistedSyncMode(syncMode),
        assignedToMe
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
        const result = await window.api.integrations.importProviderIssues({
          projectId: project.id,
          connectionId,
          groupId: provider === 'linear' ? teamId : undefined,
          scopeId: provider === 'linear' ? linearProjectId || undefined : selectedGitHubProject?.id,
          limit: 50
        })
        imported = result.imported
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
      const connection =
        provider === 'github'
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

  return {
    // passthrough
    project,
    provider,
    connectionLocked,
    // navigation
    step,
    setStep,
    canGoNext,
    // data
    connections,
    teams,
    linearProjects,
    githubProjects,
    providerStatuses,
    selectedGitHubProject,
    // loading flags
    loadingConnections,
    loadingTeams,
    loadingProjects,
    loadingGithubProjects,
    loadingStatuses,
    saving,
    connectingAccount,
    applyingStatuses,
    // message + connect form
    message,
    showConnectForm,
    setShowConnectForm,
    connectionCredential,
    setConnectionCredential,
    // selections
    connectionId,
    setConnectionId,
    teamId,
    setTeamId,
    linearProjectId,
    setLinearProjectId,
    githubProjectId,
    setGithubProjectId,
    syncMode,
    setSyncMode,
    syncModeOptions,
    assignedToMe,
    setAssignedToMe,
    conflictPolicy,
    setConflictPolicy,
    // statuses
    categoryOverrides,
    setCategoryOverrides,
    taskRemapping,
    setTaskRemapping,
    statusSetupComplete,
    // status labels (review)
    mappedStatuses,
    openStatusLabel,
    closedStatusLabel,
    // preview
    previewLoading,
    previewLoaded,
    previewCount,
    previewImportableCount,
    // handlers
    handleApplyStatuses,
    handleSaveProfile,
    handleConnectAccount
  }
}

export type WizardState = ReturnType<typeof useProjectIntegrationSetupWizard>
