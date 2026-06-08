/**
 * cap-followup-github-project-settings — sub-cap A shim (Phase 7 worker AN).
 *
 * Routes the READ side of `window.api.integrations.*` through the sidecar's
 * JsonRpcHost so ProjectSettingsDialog + IntegrationsTab + task-detail's
 * ExternalSyncCard get real rows instead of the stub Proxy's null/[].
 *
 * Methods intentionally unwired (mutations + provider-status writes + sync
 * engine + test channels) fall back to the Proxy stub so unmigrated call
 * sites degrade the way they did pre-AN. Sub-cap B (AK) wires mutations;
 * sub-cap C wires the sync engine; sub-cap D (AM) wires
 * `integrations:test:*` via `test-invoke.ts`.
 */

import { jsonRpcCall } from '../transport/mojo'
import { makeStubNamespace } from './stub-factory'

type Any = unknown

async function invoke<T = Any>(method: string, ...args: unknown[]): Promise<T> {
  return jsonRpcCall<T>(method, args)
}

const reads = {
  listConnections: (provider?: string) =>
    invoke('integrations:list-connections', provider),
  getConnectionUsage: (connectionId: string) =>
    invoke('integrations:get-connection-usage', connectionId),
  getProjectConnection: (projectId: string, provider: string) =>
    invoke('integrations:get-project-connection', projectId, provider),
  getProjectMapping: (projectId: string, provider: string) =>
    invoke('integrations:get-project-mapping', projectId, provider),
  getLink: (taskId: string, provider: string) =>
    invoke('integrations:get-link', taskId, provider),
  getTaskSyncStatus: (taskId: string, provider: string) =>
    invoke('integrations:get-task-sync-status', taskId, provider),
  getBatchTaskSyncStatus: (taskIds: string[], provider: string) =>
    invoke('integrations:get-batch-task-sync-status', taskIds, provider),
  listGithubRepositories: (connectionId: string) =>
    invoke('integrations:list-github-repositories', connectionId),
  listGithubProjects: (connectionId: string) =>
    invoke('integrations:list-github-projects', connectionId),
  listGithubRepositoryIssues: (input: Any) =>
    invoke('integrations:list-github-repository-issues', input),
  listGithubIssues: (input: Any) =>
    invoke('integrations:list-github-issues', input),
  listLinearTeams: (connectionId: string) =>
    invoke('integrations:list-linear-teams', connectionId),
  listLinearProjects: (connectionId: string, teamId: string) =>
    invoke('integrations:list-linear-projects', connectionId, teamId),
  listLinearIssues: (input: Any) =>
    invoke('integrations:list-linear-issues', input),
  listProviderGroups: (connectionId: string) =>
    invoke('integrations:list-provider-groups', connectionId),
  listProviderScopes: (connectionId: string, groupId: string) =>
    invoke('integrations:list-provider-scopes', connectionId, groupId),
  listProviderIssues: (input: Any) =>
    invoke('integrations:list-provider-issues', input),
}

/** sub-cap B mutations (worker DP, 2026-04-26). github-only path; Linear /
 * Jira branches in the underlying handler still read credentials and remain
 * deferred. Wired here so seedGithubRepoMocks (spec 39 test bodies) and
 * IntegrationsTab clear/set callsites stop hitting the stub Proxy. The
 * importGithubRepositoryIssues + bulk-sync trio are already wired via
 * the read+import path under their own allowlist.
 *
 * sub-cap C bulk-sync (worker EF, 2026-04-25). pushTask / pullTask /
 * pushUnlinkedTasks complete the IntegrationsTab.handleCheckDiffs +
 * handlePushLocalAhead + handlePullRemoteAhead chain that gates spec 39
 * test 3 (`GitHub bulk sync controls check diffs and run push/pull`).
 * Underlying sidecar handlers (already in SYNC_METHODS allowlist per BA)
 * short-circuit on github mock state in fetch/updateRemoteIssueNormalized,
 * so no real GitHub API call fires when tests have seeded mock issues.
 * pushUnlinkedTasks goes through the no-mock pushNewTaskToProviders path
 * but only walks unlinked rows — when every spec-seeded issue is imported
 * (linked) the loop is a no-op and never reaches adapter.createIssue. */
const mutations = {
  clearProjectProvider: (input: Any) =>
    invoke('integrations:clear-project-provider', input),
  setProjectMapping: (input: Any) =>
    invoke('integrations:set-project-mapping', input),
  applyStatusSync: (input: Any) =>
    invoke('integrations:apply-status-sync', input),
  importGithubRepositoryIssues: (input: Any) =>
    invoke('integrations:import-github-repository-issues', input),
  pushTask: (input: Any) =>
    invoke('integrations:push-task', input),
  pullTask: (input: Any) =>
    invoke('integrations:pull-task', input),
  pushUnlinkedTasks: (input: Any) =>
    invoke('integrations:push-unlinked-tasks', input),
}

const fallback = makeStubNamespace('integrations') as Record<string, unknown>
const wired = new Set([...Object.keys(reads), ...Object.keys(mutations)])
const wiredImpl: Record<string, unknown> = { ...reads, ...mutations }

export const integrationsShim = new Proxy({} as Record<string, unknown>, {
  get(_t, prop) {
    if (typeof prop !== 'string') return undefined
    if (wired.has(prop)) return wiredImpl[prop]
    return fallback[prop]
  },
})
