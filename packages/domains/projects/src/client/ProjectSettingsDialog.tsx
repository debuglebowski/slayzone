import { useState, useEffect, useCallback } from 'react'
import {
  ArrowLeft,
  ChevronRight,
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
  CircleX,
  Loader2
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@slayzone/ui'
import { SettingsLayout } from '@slayzone/ui'
import { Button, IconButton } from '@slayzone/ui'
import { toast } from '@slayzone/ui'
import { Input } from '@slayzone/ui'
import { Label } from '@slayzone/ui'
import { ColorPicker } from '@slayzone/ui'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@slayzone/ui'
import { Checkbox } from '@slayzone/ui'
import { Card, CardContent, CardHeader, CardTitle } from '@slayzone/ui'
import { Switch } from '@slayzone/ui'
import { Tabs, TabsList, TabsTrigger } from '@slayzone/ui'
import { cn } from '@slayzone/ui'
import {
  ContextManagerSettings,
  type ProjectContextManagerTab,
  type GlobalContextManagerSection
} from '../../../ai-config/src/client/ContextManagerSettings'
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
  return parts.join(' • ')
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

interface ProjectSettingsDialogProps {
  project: Project | null
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTab?: 'general' | 'environment' | 'columns' | 'integrations' | 'ai-config'
  integrationOnboardingProvider?: IntegrationProvider | null
  onIntegrationOnboardingHandled?: () => void
  onOpenGlobalAiConfig?: (section: GlobalContextManagerSection) => void
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

function providerDisplayName(provider: IntegrationProvider): string {
  return provider === 'github' ? 'GitHub Projects' : 'Linear'
}

export function ProjectSettingsDialog({
  project,
  open,
  onOpenChange,
  initialTab = 'general',
  integrationOnboardingProvider = null,
  onIntegrationOnboardingHandled,
  onOpenGlobalAiConfig,
  onUpdated
}: ProjectSettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<'general' | 'environment' | 'columns' | 'integrations' | 'ai-config'>('general')
  const [name, setName] = useState('')
  const [color, setColor] = useState('')
  const [path, setPath] = useState('')
  const [autoCreateWorktreeOverride, setAutoCreateWorktreeOverride] = useState<'inherit' | 'on' | 'off'>('inherit')
  const [worktreeSourceBranch, setWorktreeSourceBranch] = useState('')
  const [columnsDraft, setColumnsDraft] = useState<ColumnConfig[]>(() => DEFAULT_COLUMNS.map((column) => ({ ...column })))
  const [loading, setLoading] = useState(false)
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
  const [githubSyncMode, setGithubSyncMode] = useState<IntegrationSyncMode>('one_way')
  const [linearSyncTeamId, setLinearSyncTeamId] = useState('')
  const [linearSyncProjectId, setLinearSyncProjectId] = useState('')
  const [linearSyncTeams, setLinearSyncTeams] = useState<LinearTeam[]>([])
  const [linearSyncProjects, setLinearSyncProjects] = useState<LinearProject[]>([])
  const [loadingLinearSyncTeams, setLoadingLinearSyncTeams] = useState(false)
  const [loadingLinearSyncProjects, setLoadingLinearSyncProjects] = useState(false)
  const [linearSyncMode, setLinearSyncMode] = useState<IntegrationSyncMode>('one_way')
  const [syncSettingsMessage, setSyncSettingsMessage] = useState('')
  const [savingSyncProvider, setSavingSyncProvider] = useState<IntegrationProvider | null>(null)
  const [pullingLinearSyncNow, setPullingLinearSyncNow] = useState(false)
  const [resyncingStatuses, setResyncingStatuses] = useState<IntegrationProvider | null>(null)
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
  const [contextManagerTab, setContextManagerTab] = useState<ProjectContextManagerTab>('config')
  const [contextManagerEnabled, setContextManagerEnabled] = useState(false)
  const [execType, setExecType] = useState<'host' | 'docker' | 'ssh'>('host')
  const [execContainer, setExecContainer] = useState('')
  const [execSshTarget, setExecSshTarget] = useState('')
  const [execWorkdir, setExecWorkdir] = useState('')
  const [execShell, setExecShell] = useState('')
  const [testingConnection, setTestingConnection] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null)

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
      const ctx = project.execution_context
      if (ctx?.type === 'docker') {
        setExecType('docker')
        setExecContainer(ctx.container)
        setExecWorkdir(ctx.workdir || '')
        setExecShell(ctx.shell || '')
        setExecSshTarget('')
      } else if (ctx?.type === 'ssh') {
        setExecType('ssh')
        setExecSshTarget(ctx.target)
        setExecWorkdir(ctx.workdir || '')
        setExecShell(ctx.shell || '')
        setExecContainer('')
      } else {
        setExecType('host')
        setExecContainer('')
        setExecSshTarget('')
        setExecWorkdir('')
        setExecShell('')
      }
      setTestResult(null)
    }
  }, [project])

  useEffect(() => {
    if (open) {
      setActiveTab(initialTab)
      setContextManagerTab('config')
      setSelectedIntegrationEntry(
        integrationOnboardingProvider === 'github'
          ? 'github_projects'
          : integrationOnboardingProvider === 'linear'
            ? 'linear'
            : null
      )
      setSelectedIntegrationMode(integrationOnboardingProvider ? 'continuous' : null)
    }
  }, [open, project?.id, initialTab])

  useEffect(() => {
    if (!open) return
    if (!integrationOnboardingProvider) return
    setActiveTab('integrations')
    setSelectedIntegrationEntry(integrationOnboardingProvider === 'github' ? 'github_projects' : 'linear')
    setSelectedIntegrationMode('continuous')
    onIntegrationOnboardingHandled?.()
  }, [open, integrationOnboardingProvider, onIntegrationOnboardingHandled])

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

  const reloadIntegrationState = useCallback(async () => {
    if (!open || !project) return
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
      } catch (error) {
        setGithubRepoImportMessage(error instanceof Error ? error.message : String(error))
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
      .then((teams) => {
        setLinearSyncTeams(teams)
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
      .then((teams) => {
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
          if (current && projects.some((project) => project.id === current)) return current
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
  }

  const handleDisableSyncForProvider = async (provider: IntegrationProvider) => {
    if (!project) return

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
    if (!project) return
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
    if (!project || !githubProjectConnectionId || !githubSyncProjectId) {
      setSyncSettingsMessage('Choose a GitHub Project first')
      return
    }
    const selectedProject = githubSyncProjects.find((projectOption) => projectOption.id === githubSyncProjectId)
    if (!selectedProject) {
      setSyncSettingsMessage('Choose a valid GitHub Project')
      return
    }

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
        syncMode: githubSyncMode
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
    if (!project || !linearProjectConnectionId || !linearSyncTeamId) {
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
    if (!project || !linearSyncEnabled) {
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

  const handleResyncStatuses = async (provider: IntegrationProvider) => {
    if (!project) return
    setResyncingStatuses(provider)
    try {
      const preview = await window.api.integrations.resyncProviderStatuses({
        projectId: project.id,
        provider
      })

      const { diff } = preview
      const lines: string[] = []
      for (const s of diff.added) lines.push(`+ ${s.name} (new)`)
      for (const s of diff.removed) lines.push(`- ${s.label} (removed)`)
      for (const s of diff.renamed) lines.push(`~ ${s.old.label} → ${s.new.name} (renamed)`)

      if (lines.length === 0) {
        toast.success('Statuses are already up to date')
        return
      }

      const confirmed = window.confirm(
        `Status changes from ${provider === 'github' ? 'GitHub' : 'Linear'}:\n\n${lines.join('\n')}\n\n` +
        (diff.removed.length > 0
          ? 'Tasks on removed statuses will move to the default status.\n\n'
          : '') +
        'Apply these changes?'
      )
      if (!confirmed) return

      await window.api.integrations.applyStatusSync({
        projectId: project.id,
        provider,
        statuses: preview.providerStatuses
      })

      toast.success(`Statuses resynced: ${lines.length} change${lines.length === 1 ? '' : 's'}`)
      ;(window as any).__slayzone_refreshData?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setResyncingStatuses(null)
    }
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
    if (execType === 'docker' && !execContainer.trim()) return
    if (execType === 'ssh' && !execSshTarget.trim()) return

    setLoading(true)
    try {
      const executionContext = execType === 'docker'
        ? { type: 'docker' as const, container: execContainer.trim(), ...(execWorkdir.trim() ? { workdir: execWorkdir.trim() } : {}), ...(execShell.trim() ? { shell: execShell.trim() } : {}) }
        : execType === 'ssh'
          ? { type: 'ssh' as const, target: execSshTarget.trim(), ...(execWorkdir.trim() ? { workdir: execWorkdir.trim() } : {}), ...(execShell.trim() ? { shell: execShell.trim() } : {}) }
          : null

      const updated = await window.api.db.updateProject({
        id: project.id,
        name: name.trim(),
        color,
        path: path || null,
        autoCreateWorktreeOnTaskCreate:
          autoCreateWorktreeOverride === 'inherit'
            ? null
            : autoCreateWorktreeOverride === 'on',
        worktreeSourceBranch: worktreeSourceBranch.trim() || null,
        executionContext
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
        projectId: project?.id,
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

    if (!project || !connectionId || !teamId) return
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
        projectId: project?.id,
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
    if (!project || !connectionId || !githubRepositoryFullName) return
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
    if (!project) return []
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
    if (!project) return
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
    if (!project) return
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
    if (!project) return
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
  const normalizedLinearSyncProjectId = linearSyncProjectId || null
  const githubSyncHasChanges = githubMappingSource
    ? (
      githubMappingSource.connection_id !== githubProjectConnectionId ||
      githubMappingSource.external_project_id !== githubSyncProjectId ||
      githubMappingSource.sync_mode !== githubSyncMode
    )
    : Boolean(githubSyncProjectId)
  const linearSyncHasChanges = linearMappingSource
    ? (
      linearMappingSource.connection_id !== linearProjectConnectionId ||
      linearMappingSource.external_team_id !== linearSyncTeamId ||
      (linearMappingSource.external_project_id ?? null) !== normalizedLinearSyncProjectId ||
      linearMappingSource.sync_mode !== linearSyncMode
    )
    : Boolean(linearSyncTeamId)
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
    (issue) => issue.linkedTaskId && issue.linkedProjectId === project?.id
  ).length
  const githubRepoLinkedElsewhereCount = githubRepoSortedIssues.filter(
    (issue) => issue.linkedTaskId && issue.linkedProjectId && issue.linkedProjectId !== project?.id
  ).length
  const githubRepoImportableIdSet = new Set(githubRepoImportableIssues.map((issue) => issue.id))
  const selectedGithubRepoImportableCount = [...selectedGithubRepoIssueIds].filter((id) =>
    githubRepoImportableIdSet.has(id)
  ).length
  const canImportGithubRepoIssues = Boolean(
    project &&
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
  const navItems: Array<{ key: typeof activeTab; label: string }> = [
    { key: 'general', label: 'General' },
    { key: 'environment', label: 'Environment' },
    { key: 'columns', label: 'Task statuses' },
    ...(import.meta.env.DEV ? [{ key: 'integrations' as const, label: 'Integrations' }] : []),
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
                description="Configure the project identity and repository defaults."
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

          {activeTab === 'environment' && (
            <div className="w-full space-y-6">
              <SettingsTabIntro
                title="Environment"
                description="Choose where coding agents run for this project. By default they run on this machine, but you can run them inside a Docker container or on a remote machine via SSH."
              />
              <form onSubmit={handleSubmit} className="space-y-6">
                <div className="space-y-1">
                  <Label htmlFor="exec-context">Run agents in</Label>
                  <Select
                    value={execType}
                    onValueChange={(value) => {
                      setExecType(value as typeof execType)
                      setTestResult(null)
                    }}
                  >
                    <SelectTrigger id="exec-context" className="max-w-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="host">This machine</SelectItem>
                      <SelectItem value="docker">A Docker container</SelectItem>
                      <SelectItem value="ssh">A remote machine (SSH)</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {execType === 'host' && 'Agents run directly on your machine using the project path as the working directory.'}
                    {execType === 'docker' && 'Agents run inside an already-running Docker container. Slay attaches via docker exec.'}
                    {execType === 'ssh' && 'Agents run on a remote machine. Slay connects via SSH and launches a shell there.'}
                  </p>
                </div>
                {execType === 'docker' && (
                  <div className="space-y-3 rounded-lg border border-border/60 p-3">
                    <div className="space-y-1">
                      <Label htmlFor="exec-container">Container name</Label>
                      <Input id="exec-container" value={execContainer} onChange={(e) => setExecContainer(e.target.value)} placeholder="my-dev-container" className="max-w-sm" />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="exec-workdir">Working directory inside container</Label>
                      <Input id="exec-workdir" value={execWorkdir} onChange={(e) => setExecWorkdir(e.target.value)} placeholder="/workspace" className="max-w-sm" />
                      <p className="text-xs text-muted-foreground">Path inside the container where the agent starts. Defaults to the project path.</p>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="exec-shell">Shell inside container</Label>
                      <Input id="exec-shell" value={execShell} onChange={(e) => setExecShell(e.target.value)} placeholder="/bin/bash" className="max-w-sm" />
                      <p className="text-xs text-muted-foreground">Defaults to /bin/bash.</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!execContainer.trim() || testingConnection}
                        onClick={async () => {
                          setTestingConnection(true)
                          setTestResult(null)
                          const result = await window.api.pty.testExecutionContext({ type: 'docker', container: execContainer.trim() }).catch((e: unknown) => ({ success: false as const, error: e instanceof Error ? e.message : String(e) }))
                          setTestResult(result)
                          setTestingConnection(false)
                        }}
                      >
                        {testingConnection ? 'Testing...' : 'Test connection'}
                      </Button>
                      {testResult && (
                        <span className={cn('text-xs', testResult.success ? 'text-green-500' : 'text-red-500')}>
                          {testResult.success ? 'Connected' : testResult.error || 'Failed'}
                        </span>
                      )}
                    </div>
                  </div>
                )}
                {execType === 'ssh' && (
                  <div className="space-y-3 rounded-lg border border-border/60 p-3">
                    <div className="space-y-1">
                      <Label htmlFor="exec-ssh-target">Host</Label>
                      <Input id="exec-ssh-target" value={execSshTarget} onChange={(e) => setExecSshTarget(e.target.value)} placeholder="user@hostname" className="max-w-sm" />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="exec-workdir-ssh">Working directory on remote</Label>
                      <Input id="exec-workdir-ssh" value={execWorkdir} onChange={(e) => setExecWorkdir(e.target.value)} placeholder="/home/user/project" className="max-w-sm" />
                      <p className="text-xs text-muted-foreground">Path on the remote machine where the agent starts. Defaults to the project path.</p>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="exec-shell-ssh">Shell on remote</Label>
                      <Input id="exec-shell-ssh" value={execShell} onChange={(e) => setExecShell(e.target.value)} placeholder="/bin/bash" className="max-w-sm" />
                      <p className="text-xs text-muted-foreground">Defaults to /bin/bash.</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!execSshTarget.trim() || testingConnection}
                        onClick={async () => {
                          setTestingConnection(true)
                          setTestResult(null)
                          const result = await window.api.pty.testExecutionContext({ type: 'ssh', target: execSshTarget.trim() }).catch((e: unknown) => ({ success: false as const, error: e instanceof Error ? e.message : String(e) }))
                          setTestResult(result)
                          setTestingConnection(false)
                        }}
                      >
                        {testingConnection ? 'Testing...' : 'Test connection'}
                      </Button>
                      {testResult && (
                        <span className={cn('text-xs', testResult.success ? 'text-green-500' : 'text-red-500')}>
                          {testResult.success ? 'Connected' : testResult.error || 'Failed'}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">Key-based auth must be set up so no password prompt is needed.</p>
                  </div>
                )}
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={loading}>
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

          {import.meta.env.DEV && activeTab === 'integrations' && (
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
                                    {disconnectingProjectConnectionProvider === category.provider ? 'Disconnecting…' : 'Disconnect'}
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
                    <span className="text-xs text-muted-foreground">
                      {selectedIntegrationViewMeta.description}
                    </span>
                  </div>

                  {(isGithubContinuousView || isLinearContinuousView) && syncSetupProvider ? (
                    <div className="space-y-4">
                      {syncSetupProvider === 'github' ? (
                        githubConnected ? (
                          <Card className="gap-4 py-4">
                            <CardHeader className="px-4">
                              <div className="flex items-center justify-between gap-3">
                                <CardTitle className="text-base">GitHub Continuous Sync</CardTitle>
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-muted-foreground">Sync enabled</span>
                                  <Switch
                                    id="github-sync-enabled"
                                    checked={githubSyncEnabled}
                                    disabled={switchingProvider || savingSyncProvider === 'github'}
                                    onCheckedChange={(checked) => {
                                      if (checked === true) {
                                        void handleSaveGithubSyncSettings()
                                      } else {
                                        void handleDisableSyncForProvider('github')
                                      }
                                    }}
                                  />
                                </div>
                              </div>
                            </CardHeader>
                            <CardContent className="space-y-3 px-4">
                              <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                                <Label htmlFor="github-sync-project" className="text-sm">
                                  GitHub Project
                                </Label>
                                <Select
                                  value={githubSyncProjectId || '__none__'}
                                  onValueChange={(value) => setGithubSyncProjectId(value === '__none__' ? '' : value)}
                                  disabled={!githubProjectConnectionId || loadingGithubSyncProjects}
                                >
                                  <SelectTrigger id="github-sync-project" className="w-full max-w-md">
                                    <SelectValue placeholder={loadingGithubSyncProjects ? 'Loading projects…' : 'Choose GitHub Project'} />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {githubSyncProjects.length === 0 ? (
                                      <SelectItem value="__none__" disabled>No GitHub Projects found — use a classic PAT with repo scope</SelectItem>
                                    ) : null}
                                    {githubSyncProjects.map((projectOption) => (
                                      <SelectItem key={projectOption.id} value={projectOption.id}>
                                        {projectOption.owner.login}#{projectOption.number} - {projectOption.title}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>

                              <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                                <Label htmlFor="github-sync-mode" className="text-sm">
                                  Sync mode
                                </Label>
                                <Select
                                  value={githubSyncMode}
                                  onValueChange={(value) => setGithubSyncMode(value as IntegrationSyncMode)}
                                >
                                  <SelectTrigger id="github-sync-mode" className="w-full max-w-md">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="one_way">One-way</SelectItem>
                                    <SelectItem value="two_way">Two-way</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>

                              <div className="flex items-center justify-end gap-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => void handleResyncStatuses('github')}
                                  disabled={resyncingStatuses === 'github'}
                                >
                                  {resyncingStatuses === 'github' ? 'Resyncing…' : 'Resync statuses'}
                                </Button>
                                <Button
                                  size="sm"
                                  disabled={
                                    !githubSyncProjectId ||
                                    savingSyncProvider === 'github' ||
                                    !githubSyncHasChanges
                                  }
                                  onClick={() => void handleSaveGithubSyncSettings()}
                                >
                                  {savingSyncProvider === 'github'
                                    ? (
                                      <>
                                        <Loader2 className="mr-1 size-3 animate-spin" />
                                        Saving…
                                      </>
                                    )
                                    : githubSyncEnabled
                                      ? 'Save settings'
                                      : 'Enable sync'}
                                </Button>
                              </div>

                              {syncSettingsMessage ? (
                                <p className="text-xs text-muted-foreground">{syncSettingsMessage}</p>
                              ) : null}
                            </CardContent>
                          </Card>
                        ) : (
                          <Card className="gap-4 py-4">
                            <CardHeader className="px-4">
                              <CardTitle className="text-base">Connect GitHub</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-3 px-4">
                              <p className="text-sm text-muted-foreground">
                                Connect GitHub from the category header to configure sync.
                              </p>
                            </CardContent>
                          </Card>
                        )
                      ) : (
                        linearConnected ? (
                          <Card className="gap-4 py-4">
                            <CardHeader className="px-4">
                              <div className="flex items-center justify-between gap-3">
                                <CardTitle className="text-base">Linear Continuous Sync</CardTitle>
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-muted-foreground">Sync enabled</span>
                                  <Switch
                                    id="linear-sync-enabled"
                                    checked={linearSyncEnabled}
                                    disabled={switchingProvider || savingSyncProvider === 'linear'}
                                    onCheckedChange={(checked) => {
                                      if (checked === true) {
                                        void handleSaveLinearSyncSettings()
                                      } else {
                                        void handleDisableSyncForProvider('linear')
                                      }
                                    }}
                                  />
                                </div>
                              </div>
                            </CardHeader>
                            <CardContent className="space-y-3 px-4">
                              <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                                <Label htmlFor="linear-sync-team" className="text-sm">
                                  Team
                                </Label>
                                <Select
                                  value={linearSyncTeamId || '__none__'}
                                  onValueChange={(value) => setLinearSyncTeamId(value === '__none__' ? '' : value)}
                                  disabled={!linearProjectConnectionId || loadingLinearSyncTeams}
                                >
                                  <SelectTrigger id="linear-sync-team" className="w-full max-w-md">
                                    <SelectValue placeholder={loadingLinearSyncTeams ? 'Loading teams…' : 'Choose team'} />
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

                              <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                                <Label htmlFor="linear-sync-project" className="text-sm">
                                  Project (optional)
                                </Label>
                                <Select
                                  value={linearSyncProjectId || '__none__'}
                                  onValueChange={(value) => setLinearSyncProjectId(value === '__none__' ? '' : value)}
                                  disabled={!linearProjectConnectionId || !linearSyncTeamId || loadingLinearSyncProjects}
                                >
                                  <SelectTrigger id="linear-sync-project" className="w-full max-w-md">
                                    <SelectValue placeholder={loadingLinearSyncProjects ? 'Loading projects…' : 'All team issues'} />
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

                              <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                                <Label htmlFor="linear-sync-mode" className="text-sm">
                                  Sync mode
                                </Label>
                                <Select
                                  value={linearSyncMode}
                                  onValueChange={(value) => setLinearSyncMode(value as IntegrationSyncMode)}
                                >
                                  <SelectTrigger id="linear-sync-mode" className="w-full max-w-md">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="one_way">One-way</SelectItem>
                                    <SelectItem value="two_way">Two-way</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>

                              <div className="flex items-center justify-end gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={resyncingStatuses === 'linear'}
                                  onClick={() => void handleResyncStatuses('linear')}
                                >
                                  {resyncingStatuses === 'linear' ? 'Resyncing…' : 'Resync statuses'}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={!linearSyncEnabled || pullingLinearSyncNow}
                                  onClick={() => void handleManualLinearPull()}
                                >
                                  {pullingLinearSyncNow ? (
                                    <>
                                      <Loader2 className="mr-1 size-3 animate-spin" />
                                      Pulling…
                                    </>
                                  ) : 'Pull now'}
                                </Button>
                                <Button
                                  size="sm"
                                  disabled={
                                    !linearSyncTeamId ||
                                    savingSyncProvider === 'linear' ||
                                    pullingLinearSyncNow ||
                                    !linearSyncHasChanges
                                  }
                                  onClick={() => void handleSaveLinearSyncSettings()}
                                >
                                  {savingSyncProvider === 'linear'
                                    ? (
                                      <>
                                        <Loader2 className="mr-1 size-3 animate-spin" />
                                        Saving…
                                      </>
                                    )
                                    : linearSyncEnabled
                                      ? 'Save settings'
                                      : 'Enable sync'}
                                </Button>
                              </div>

                              {syncSettingsMessage ? (
                                <p className="text-xs text-muted-foreground">{syncSettingsMessage}</p>
                              ) : null}
                            </CardContent>
                          </Card>
                        ) : (
                          <Card className="gap-4 py-4">
                            <CardHeader className="px-4">
                              <CardTitle className="text-base">Connect Linear</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-3 px-4">
                              <p className="text-sm text-muted-foreground">
                                Connect Linear from the category header to configure sync.
                              </p>
                            </CardContent>
                          </Card>
                        )
                      )}

                      {isGithubContinuousView ? (
                        <Card className="gap-4 py-4">
                <CardHeader className="px-4">
                  <CardTitle className="text-base">GitHub Project Sync Controls</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 px-4">
                  {githubMappingSource ? (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                          Linked tasks: {githubSummary.total}
                        </span>
                        <span className="rounded bg-emerald-500/15 px-2 py-1 text-[11px] text-emerald-300">
                          In sync: {githubSummary.in_sync}
                        </span>
                        <span className="rounded bg-blue-500/15 px-2 py-1 text-[11px] text-blue-300">
                          Local ahead: {githubSummary.local_ahead}
                        </span>
                        <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-300">
                          Remote ahead: {githubSummary.remote_ahead}
                        </span>
                        <span className="rounded bg-red-500/15 px-2 py-1 text-[11px] text-red-300">
                          Conflicts: {githubSummary.conflict}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          data-testid="github-project-check-diffs"
                          disabled={checkingGithubSync || pushingGithubSync || pullingGithubSync}
                          onClick={() => void handleCheckGithubDiffs()}
                        >
                          {checkingGithubSync ? (
                            <>
                              <Loader2 className="mr-1 size-3 animate-spin" />
                              Checking…
                            </>
                          ) : 'Check all diffs'}
                        </Button>
                        <Button
                          size="sm"
                          data-testid="github-project-push-local-ahead"
                          disabled={checkingGithubSync || pushingGithubSync || pullingGithubSync}
                          onClick={() => void handlePushGithubLocalAhead()}
                        >
                          {pushingGithubSync ? (
                            <>
                              <Loader2 className="mr-1 size-3 animate-spin" />
                              Pushing…
                            </>
                          ) : 'Push all local-ahead'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          data-testid="github-project-pull-remote-ahead"
                          disabled={checkingGithubSync || pushingGithubSync || pullingGithubSync}
                          onClick={() => void handlePullGithubRemoteAhead()}
                        >
                          {pullingGithubSync ? (
                            <>
                              <Loader2 className="mr-1 size-3 animate-spin" />
                              Pulling…
                            </>
                          ) : 'Pull all remote-ahead'}
                        </Button>
                      </div>

                      <p className="text-xs text-muted-foreground">
                        Source: {githubMappingSource.external_team_key}
                        {githubSummary.checkedAt ? ` • Checked ${new Date(githubSummary.checkedAt).toLocaleTimeString()}` : ''}
                        {githubSummary.errors > 0 ? ` • ${githubSummary.errors} errors` : ''}
                      </p>

                      {githubSyncRows.length > 0 ? (
                        <div className="max-h-40 space-y-1 overflow-y-auto rounded border p-2">
                          {githubSyncRows.slice(0, 12).map((row) => (
                            <div key={row.link.id} className="flex items-center justify-between gap-2 text-xs">
                              <span className="min-w-0 truncate text-muted-foreground">{row.link.external_key}</span>
                              <span className={cn(
                                'shrink-0 rounded px-1.5 py-0.5 uppercase tracking-wide',
                                row.status.state === 'in_sync' && 'bg-emerald-500/15 text-emerald-300',
                                row.status.state === 'local_ahead' && 'bg-blue-500/15 text-blue-300',
                                row.status.state === 'remote_ahead' && 'bg-amber-500/15 text-amber-300',
                                row.status.state === 'conflict' && 'bg-red-500/15 text-red-300',
                                row.status.state === 'unknown' && 'bg-muted text-muted-foreground'
                              )}>
                                {row.status.state.replace('_', ' ')}
                              </span>
                            </div>
                          ))}
                          {githubSyncRows.length > 12 ? (
                            <p className="text-[11px] text-muted-foreground">Showing first 12 of {githubSyncRows.length}</p>
                          ) : null}
                        </div>
                      ) : null}

                      {githubSyncMessage ? <p className="text-xs text-muted-foreground">{githubSyncMessage}</p> : null}
                    </>
                  ) : (
                    <div className="rounded-md border border-dashed p-3">
                      <p className="text-sm text-muted-foreground">
                        Configure a GitHub source first, then use sync controls here.
                      </p>
                    </div>
                  )}
                </CardContent>
                    </Card>
                      ) : null}
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
                              placeholder={loadingGithubRepositories ? 'Loading repositories…' : 'Choose repository'}
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
                            ? 'Loading repository issues…'
                            : githubRepoSortedIssues.length > 0
                              ? githubRepoIssueQueryNormalized
                                ? `${githubRepoFilteredIssues.length} of ${githubRepoSortedIssues.length} issues shown`
                                : `${githubRepoSortedIssues.length} issues loaded`
                              : 'Load repository issues to import selected tasks'}
                          {githubRepoSortedIssues.length > 0 ? (
                            <p>
                              {githubRepoImportableIssues.length} importable
                              {githubRepoLinkedInProjectCount > 0 ? ` • ${githubRepoLinkedInProjectCount} linked here` : ''}
                              {githubRepoLinkedElsewhereCount > 0 ? ` • ${githubRepoLinkedElsewhereCount} linked elsewhere` : ''}
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
                            {loadingGithubRepoIssues ? 'Loading…' : githubRepoSortedIssues.length > 0 ? 'Refresh issues' : 'Load issues'}
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
                                  {issue.linkedProjectId === project?.id ? (
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
                                    {issue.linkedProjectId && issue.linkedProjectId !== project?.id ? (
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
                            ? 'Importing…'
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
                                        <SelectValue placeholder={loadingLinearImportTeams ? 'Loading teams…' : 'Choose team'} />
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
                                        <SelectValue placeholder={loadingLinearImportProjects ? 'Loading projects…' : 'All team issues'} />
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
                        ? 'Loading issues…'
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
                        ? 'Importing…'
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
                    <TabsTrigger value="config" data-testid="project-context-tab-config">Config</TabsTrigger>
                    <TabsTrigger value="files" data-testid="project-context-tab-files">Files</TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
              <ContextManagerSettings
                scope="project"
                projectId={project?.id ?? null}
                projectPath={project?.path}
                projectName={project?.name}
                projectTab={contextManagerTab}
                onOpenGlobalAiConfig={onOpenGlobalAiConfig}
              />
            </div>
          )}
        </SettingsLayout>
        {project && connectionModalState ? (
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
      </DialogContent>
    </Dialog>
  )
}
