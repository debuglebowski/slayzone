/**
 * Mock linear-client for handler contract tests.
 * Mutable `_mock` object lets each test control return values.
 */
import type { LinearIssueSummary } from '../../../packages/domains/integrations/src/shared'

export const _mock = {
  getViewer: async (_apiKey: string) => ({
    workspaceId: 'ws-1',
    workspaceName: 'Test Workspace',
    accountLabel: 'test@test.com'
  }),
  listTeams: async (_apiKey: string) => ({
    teams: [{ id: 'team-1', key: 'ENG', name: 'Engineering' }],
    orgUrlKey: 'test-workspace'
  }),
  listProjects: async (_apiKey: string, _teamId: string) => [
    { id: 'lp-1', name: 'Alpha', teamId: 'team-1' }
  ],
  listWorkflowStates: async (_apiKey: string, _teamId: string) => [
    { id: 'st-triage', type: 'triage' },
    { id: 'st-backlog', type: 'backlog' },
    { id: 'st-unstarted', type: 'unstarted' },
    { id: 'st-started', type: 'started' },
    { id: 'st-completed', type: 'completed' },
    { id: 'st-canceled', type: 'canceled' }
  ],
  listIssues: async (_apiKey: string, _input: unknown) => ({
    issues: [] as LinearIssueSummary[],
    nextCursor: null as string | null
  }),
  getIssue: async (_apiKey: string, _issueId: string) => null as LinearIssueSummary | null,
  getIssuesBatch: async (_apiKey: string, _issueIds: string[]) =>
    new Map<string, LinearIssueSummary>(),
  createIssue: async (_apiKey: string, _input: unknown) => null as LinearIssueSummary | null,
  updateIssue: async (_apiKey: string, _issueId: string, _input: unknown) =>
    null as LinearIssueSummary | null
}

export async function getViewer(apiKey: string) {
  return _mock.getViewer(apiKey)
}

export async function listTeams(apiKey: string) {
  return _mock.listTeams(apiKey)
}

export async function listProjects(apiKey: string, teamId: string) {
  return _mock.listProjects(apiKey, teamId)
}

export async function listWorkflowStates(apiKey: string, teamId: string) {
  return _mock.listWorkflowStates(apiKey, teamId)
}

export async function listIssues(apiKey: string, input: unknown) {
  return _mock.listIssues(apiKey, input)
}

export async function getIssue(apiKey: string, issueId: string) {
  return _mock.getIssue(apiKey, issueId)
}

export async function getIssuesBatch(apiKey: string, issueIds: string[]) {
  return _mock.getIssuesBatch(apiKey, issueIds)
}

export async function createIssue(apiKey: string, input: unknown) {
  return _mock.createIssue(apiKey, input)
}

export async function updateIssue(apiKey: string, issueId: string, input: unknown) {
  return _mock.updateIssue(apiKey, issueId, input)
}
