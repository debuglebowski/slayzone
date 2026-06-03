import type { IpcMain } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
import type {
  ConnectGithubInput,
  ConnectLinearInput,
  ConnectJiraInput,
  UpdateIntegrationConnectionInput,
  IntegrationProvider,
  ClearProjectProviderInput,
  SetProjectConnectionInput,
  ClearProjectConnectionInput,
  SetProjectMappingInput,
  ListGithubIssuesInput,
  ListGithubRepositoryIssuesInput,
  ListLinearIssuesInput,
  ImportGithubIssuesInput,
  ImportGithubRepositoryIssuesInput,
  ImportLinearIssuesInput,
  ListProviderIssuesInput,
  ImportProviderIssuesInput,
  PushTaskInput,
  PullTaskInput,
  SyncNowInput,
  PushUnlinkedTasksInput,
  FetchProviderStatusesInput,
  ApplyStatusSyncInput,
  GithubRepositorySummary,
  GithubIssueSummary
} from '../shared'
import { createIntegrationOps, ensureIntegrationSchema, type IntegrationOps } from './handlers-store'

export { ensureIntegrationSchema } from './handlers-store'

export interface IntegrationHandles {
  pushGithubTask: (taskId: string) => Promise<void>
  /** Same ops instance the IPC channels delegate to; the Electron-main host
   *  hands this to the tRPC transport (`setIntegrationOps`) so IPC + the
   *  `integrationsRouter` share one implementation while both coexist. */
  ops: IntegrationOps
}

/**
 * IPC surface for the integrations domain. Every channel delegates to the
 * shared ops factory (`createIntegrationOps`, in `./handlers-store`) so these
 * handlers and the tRPC `integrationsRouter` call one implementation while IPC
 * + tRPC coexist (renderer cutover + IPC deletion is a later slice). Test
 * channels still gate their *registration* on `enableTestChannels`.
 */
export async function registerIntegrationHandlers(
  ipcMain: IpcMain,
  db: SlayzoneDb,
  options?: { enableTestChannels?: boolean }
): Promise<IntegrationHandles> {
  await ensureIntegrationSchema(db)
  const enableTestChannels = options?.enableTestChannels ?? false
  const ops = createIntegrationOps(db, options)

  // Connections
  ipcMain.handle('integrations:connect-github', (_event, input: ConnectGithubInput) =>
    ops.connectGithub(input)
  )
  ipcMain.handle('integrations:connect-linear', (_event, input: ConnectLinearInput) =>
    ops.connectLinear(input)
  )
  ipcMain.handle('integrations:connect-jira', (_event, input: ConnectJiraInput) =>
    ops.connectJira(input)
  )
  ipcMain.handle('integrations:get-jira-transitions', (_event, taskId: string) =>
    ops.getJiraTransitions(taskId)
  )
  ipcMain.handle('integrations:update-connection', (_event, input: UpdateIntegrationConnectionInput) =>
    ops.updateConnection(input)
  )
  ipcMain.handle('integrations:list-connections', (_event, provider?: IntegrationProvider) =>
    ops.listConnections(provider)
  )
  ipcMain.handle('integrations:get-connection-usage', (_event, connectionId: string) =>
    ops.getConnectionUsage(connectionId)
  )
  ipcMain.handle('integrations:disconnect', (_event, connectionId: string) =>
    ops.disconnect(connectionId)
  )
  ipcMain.handle('integrations:clear-project-provider', (_event, input: ClearProjectProviderInput) =>
    ops.clearProjectProvider(input)
  )
  ipcMain.handle(
    'integrations:get-project-connection',
    (_event, projectId: string, provider: IntegrationProvider) =>
      ops.getProjectConnection(projectId, provider)
  )
  ipcMain.handle('integrations:set-project-connection', (_event, input: SetProjectConnectionInput) =>
    ops.setProjectConnection(input)
  )
  ipcMain.handle(
    'integrations:clear-project-connection',
    (_event, input: ClearProjectConnectionInput) => ops.clearProjectConnection(input)
  )

  // Test channels (gated) — ops always defined; only IPC registration is gated.
  if (enableTestChannels) {
    ipcMain.handle(
      'integrations:test:seed-github-connection',
      (
        _event,
        input: { id?: string; projectId?: string; token?: string; repositories?: GithubRepositorySummary[] }
      ) => ops.testSeedGithubConnection(input)
    )
    ipcMain.handle(
      'integrations:test:set-github-repositories',
      (_event, input: { connectionId: string; repositories: GithubRepositorySummary[] }) =>
        ops.testSetGithubRepositories(input)
    )
    ipcMain.handle(
      'integrations:test:set-github-repository-issues',
      (_event, input: { repositoryFullName: string; issues: GithubIssueSummary[] }) =>
        ops.testSetGithubRepositoryIssues(input)
    )
    ipcMain.handle('integrations:test:clear-github-mocks', () => ops.testClearGithubMocks())
  }

  // Github
  ipcMain.handle('integrations:list-github-repositories', (_event, connectionId: string) =>
    ops.listGithubRepositories(connectionId)
  )
  ipcMain.handle('integrations:list-github-projects', (_event, connectionId: string) =>
    ops.listGithubProjects(connectionId)
  )
  ipcMain.handle('integrations:list-github-issues', (_event, input: ListGithubIssuesInput) =>
    ops.listGithubIssues(input)
  )
  ipcMain.handle(
    'integrations:list-github-repository-issues',
    (_event, input: ListGithubRepositoryIssuesInput) => ops.listGithubRepositoryIssues(input)
  )
  ipcMain.handle('integrations:import-github-issues', (_event, input: ImportGithubIssuesInput) =>
    ops.importGithubIssues(input)
  )
  ipcMain.handle(
    'integrations:import-github-repository-issues',
    (_event, input: ImportGithubRepositoryIssuesInput) => ops.importGithubRepositoryIssues(input)
  )

  // Linear
  ipcMain.handle('integrations:list-linear-teams', (_event, connectionId: string) =>
    ops.listLinearTeams(connectionId)
  )
  ipcMain.handle(
    'integrations:list-linear-projects',
    (_event, connectionId: string, teamId: string) => ops.listLinearProjects(connectionId, teamId)
  )
  ipcMain.handle('integrations:list-linear-issues', (_event, input: ListLinearIssuesInput) =>
    ops.listLinearIssues(input)
  )
  ipcMain.handle('integrations:import-linear-issues', (_event, input: ImportLinearIssuesInput) =>
    ops.importLinearIssues(input)
  )

  // Project mapping
  ipcMain.handle('integrations:set-project-mapping', (_event, input: SetProjectMappingInput) =>
    ops.setProjectMapping(input)
  )
  ipcMain.handle(
    'integrations:get-project-mapping',
    (_event, projectId: string, provider: IntegrationProvider) =>
      ops.getProjectMapping(projectId, provider)
  )

  // Sync
  ipcMain.handle('integrations:sync-now', (_event, input: SyncNowInput) => ops.syncNow(input))
  ipcMain.handle(
    'integrations:get-task-sync-status',
    (_event, taskId: string, provider: IntegrationProvider) =>
      ops.getTaskSyncStatus(taskId, provider)
  )
  ipcMain.handle(
    'integrations:get-batch-task-sync-status',
    (_event, taskIds: string[], provider: IntegrationProvider) =>
      ops.getBatchTaskSyncStatus(taskIds, provider)
  )
  ipcMain.handle('integrations:push-task', (_event, input: PushTaskInput) => ops.pushTask(input))
  ipcMain.handle('integrations:pull-task', (_event, input: PullTaskInput) => ops.pullTask(input))
  ipcMain.handle(
    'integrations:get-link',
    (_event, taskId: string, provider: IntegrationProvider) => ops.getLink(taskId, provider)
  )
  ipcMain.handle(
    'integrations:unlink-task',
    (_event, taskId: string, provider: IntegrationProvider) => ops.unlinkTask(taskId, provider)
  )
  ipcMain.handle('integrations:push-unlinked-tasks', (_event, input: PushUnlinkedTasksInput) =>
    ops.pushUnlinkedTasks(input)
  )
  ipcMain.handle('integrations:fetch-provider-statuses', (_event, input: FetchProviderStatusesInput) =>
    ops.fetchProviderStatuses(input)
  )
  ipcMain.handle('integrations:apply-status-sync', (_event, input: ApplyStatusSyncInput) =>
    ops.applyStatusSync(input)
  )
  ipcMain.handle(
    'integrations:resync-provider-statuses',
    (_event, input: { projectId: string; provider: IntegrationProvider }) =>
      ops.resyncProviderStatuses(input)
  )

  // Generic provider-dispatched
  ipcMain.handle('integrations:list-provider-groups', (_event, connectionId: string) =>
    ops.listProviderGroups(connectionId)
  )
  ipcMain.handle(
    'integrations:list-provider-scopes',
    (_event, connectionId: string, groupId: string) => ops.listProviderScopes(connectionId, groupId)
  )
  ipcMain.handle('integrations:list-provider-issues', (_event, input: ListProviderIssuesInput) =>
    ops.listProviderIssues(input)
  )
  ipcMain.handle('integrations:import-provider-issues', (_event, input: ImportProviderIssuesInput) =>
    ops.importProviderIssues(input)
  )

  return { pushGithubTask: ops.pushGithubTask, ops }
}
