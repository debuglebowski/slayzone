import { z } from 'zod'
import { getIntegrationOps } from '../app-deps'
import { router, publicProcedure } from '../trpc'

// Mirrors the 43 `integrations:*` IPC handlers (integrations/src/main/handlers.ts).
// Both call the same ops instance (`createIntegrationOps`, injected via
// `setIntegrationOps`), so the still-registered IPC handlers and these procedures
// share one implementation while IPC + tRPC coexist (renderer cutover is a later
// slice). Complex payloads carry nested provider configs / auth-bearing fields;
// mirror the automations + diagnostics routers and pass them through unchecked
// (the still-live IPC path is validated by TypeScript only). superjson handles
// Date/token serialization end-to-end.
const anyInput = z.unknown()

export const integrationsRouter = router({
  // Connections
  connectGithub: publicProcedure.input(anyInput).mutation(({ input }) =>
    getIntegrationOps().connectGithub(input as never)
  ),
  connectLinear: publicProcedure.input(anyInput).mutation(({ input }) =>
    getIntegrationOps().connectLinear(input as never)
  ),
  connectJira: publicProcedure.input(anyInput).mutation(({ input }) =>
    getIntegrationOps().connectJira(input as never)
  ),
  getJiraTransitions: publicProcedure.input(z.object({ taskId: z.string() })).query(({ input }) =>
    getIntegrationOps().getJiraTransitions(input.taskId)
  ),
  updateConnection: publicProcedure.input(anyInput).mutation(({ input }) =>
    getIntegrationOps().updateConnection(input as never)
  ),
  listConnections: publicProcedure
    .input(z.object({ provider: z.string().optional() }).optional())
    .query(({ input }) => getIntegrationOps().listConnections(input?.provider as never)),
  getConnectionUsage: publicProcedure
    .input(z.object({ connectionId: z.string() }))
    .query(({ input }) => getIntegrationOps().getConnectionUsage(input.connectionId)),
  disconnect: publicProcedure
    .input(z.object({ connectionId: z.string() }))
    .mutation(({ input }) => getIntegrationOps().disconnect(input.connectionId)),
  clearProjectProvider: publicProcedure.input(anyInput).mutation(({ input }) =>
    getIntegrationOps().clearProjectProvider(input as never)
  ),
  getProjectConnection: publicProcedure
    .input(z.object({ projectId: z.string(), provider: z.string() }))
    .query(({ input }) =>
      getIntegrationOps().getProjectConnection(input.projectId, input.provider as never)
    ),
  setProjectConnection: publicProcedure.input(anyInput).mutation(({ input }) =>
    getIntegrationOps().setProjectConnection(input as never)
  ),
  clearProjectConnection: publicProcedure.input(anyInput).mutation(({ input }) =>
    getIntegrationOps().clearProjectConnection(input as never)
  ),

  // Github
  listGithubRepositories: publicProcedure
    .input(z.object({ connectionId: z.string() }))
    .query(({ input }) => getIntegrationOps().listGithubRepositories(input.connectionId)),
  listGithubProjects: publicProcedure
    .input(z.object({ connectionId: z.string() }))
    .query(({ input }) => getIntegrationOps().listGithubProjects(input.connectionId)),
  listGithubIssues: publicProcedure.input(anyInput).query(({ input }) =>
    getIntegrationOps().listGithubIssues(input as never)
  ),
  importGithubIssues: publicProcedure.input(anyInput).mutation(({ input }) =>
    getIntegrationOps().importGithubIssues(input as never)
  ),
  listGithubRepositoryIssues: publicProcedure.input(anyInput).query(({ input }) =>
    getIntegrationOps().listGithubRepositoryIssues(input as never)
  ),
  importGithubRepositoryIssues: publicProcedure.input(anyInput).mutation(({ input }) =>
    getIntegrationOps().importGithubRepositoryIssues(input as never)
  ),

  // Linear
  listLinearTeams: publicProcedure
    .input(z.object({ connectionId: z.string() }))
    .query(({ input }) => getIntegrationOps().listLinearTeams(input.connectionId)),
  listLinearProjects: publicProcedure
    .input(z.object({ connectionId: z.string(), teamId: z.string() }))
    .query(({ input }) => getIntegrationOps().listLinearProjects(input.connectionId, input.teamId)),
  listLinearIssues: publicProcedure.input(anyInput).query(({ input }) =>
    getIntegrationOps().listLinearIssues(input as never)
  ),
  importLinearIssues: publicProcedure.input(anyInput).mutation(({ input }) =>
    getIntegrationOps().importLinearIssues(input as never)
  ),

  // Project mapping
  setProjectMapping: publicProcedure.input(anyInput).mutation(({ input }) =>
    getIntegrationOps().setProjectMapping(input as never)
  ),
  getProjectMapping: publicProcedure
    .input(z.object({ projectId: z.string(), provider: z.string() }))
    .query(({ input }) =>
      getIntegrationOps().getProjectMapping(input.projectId, input.provider as never)
    ),

  // Sync
  syncNow: publicProcedure.input(anyInput).mutation(({ input }) =>
    getIntegrationOps().syncNow(input as never)
  ),
  getTaskSyncStatus: publicProcedure
    .input(z.object({ taskId: z.string(), provider: z.string() }))
    .query(({ input }) =>
      getIntegrationOps().getTaskSyncStatus(input.taskId, input.provider as never)
    ),
  getBatchTaskSyncStatus: publicProcedure
    .input(z.object({ taskIds: z.array(z.string()), provider: z.string() }))
    .query(({ input }) =>
      getIntegrationOps().getBatchTaskSyncStatus(input.taskIds, input.provider as never)
    ),
  pushTask: publicProcedure.input(anyInput).mutation(({ input }) =>
    getIntegrationOps().pushTask(input as never)
  ),
  pullTask: publicProcedure.input(anyInput).mutation(({ input }) =>
    getIntegrationOps().pullTask(input as never)
  ),
  getLink: publicProcedure
    .input(z.object({ taskId: z.string(), provider: z.string() }))
    .query(({ input }) => getIntegrationOps().getLink(input.taskId, input.provider as never)),
  unlinkTask: publicProcedure
    .input(z.object({ taskId: z.string(), provider: z.string() }))
    .mutation(({ input }) => getIntegrationOps().unlinkTask(input.taskId, input.provider as never)),
  pushUnlinkedTasks: publicProcedure.input(anyInput).mutation(({ input }) =>
    getIntegrationOps().pushUnlinkedTasks(input as never)
  ),
  fetchProviderStatuses: publicProcedure.input(anyInput).mutation(({ input }) =>
    getIntegrationOps().fetchProviderStatuses(input as never)
  ),
  applyStatusSync: publicProcedure.input(anyInput).mutation(({ input }) =>
    getIntegrationOps().applyStatusSync(input as never)
  ),
  resyncProviderStatuses: publicProcedure.input(anyInput).mutation(({ input }) =>
    getIntegrationOps().resyncProviderStatuses(input as never)
  ),

  // Generic provider-dispatched
  listProviderGroups: publicProcedure
    .input(z.object({ connectionId: z.string() }))
    .query(({ input }) => getIntegrationOps().listProviderGroups(input.connectionId)),
  listProviderScopes: publicProcedure
    .input(z.object({ connectionId: z.string(), groupId: z.string() }))
    .query(({ input }) =>
      getIntegrationOps().listProviderScopes(input.connectionId, input.groupId)
    ),
  listProviderIssues: publicProcedure.input(anyInput).query(({ input }) =>
    getIntegrationOps().listProviderIssues(input as never)
  ),
  importProviderIssues: publicProcedure.input(anyInput).mutation(({ input }) =>
    getIntegrationOps().importProviderIssues(input as never)
  ),

  // Test channels (E2E only — no-op in production renderer)
  testSeedGithubConnection: publicProcedure.input(anyInput).mutation(({ input }) =>
    getIntegrationOps().testSeedGithubConnection(input as never)
  ),
  testSetGithubRepositories: publicProcedure.input(anyInput).mutation(({ input }) =>
    getIntegrationOps().testSetGithubRepositories(input as never)
  ),
  testSetGithubRepositoryIssues: publicProcedure.input(anyInput).mutation(({ input }) =>
    getIntegrationOps().testSetGithubRepositoryIssues(input as never)
  ),
  testClearGithubMocks: publicProcedure.mutation(() => getIntegrationOps().testClearGithubMocks())
})
