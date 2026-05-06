import type { ProviderStatus } from '../../shared'
import type { WorkflowCategory } from '@slayzone/workflow'
import {
  getViewer,
  listTeams,
  listProjects,
  listWorkflowStates,
  listIssues,
  getIssue,
  getIssuesBatch,
  createIssue,
  updateIssue
} from '../linear-client'
import type { LinearIssueSummary } from '../../shared'
import type {
  ProviderAdapter,
  NormalizedIssue,
  ExternalGroup,
  ExternalScope,
  ExternalKeyContext,
  IssueRef,
  ListIssuesParams,
  CreateIssueParams,
  UpdateIssueParams
} from './types'

const LINEAR_TYPE_TO_CATEGORY: Record<string, WorkflowCategory> = {
  triage: 'triage',
  backlog: 'backlog',
  unstarted: 'unstarted',
  started: 'started',
  completed: 'completed',
  canceled: 'canceled'
}

const LINEAR_HEX_TO_TAILWIND: Array<{ hex: string; tw: string }> = [
  { hex: '#95a2b3', tw: 'gray' },
  { hex: '#bec2c8', tw: 'slate' },
  { hex: '#5e6ad2', tw: 'blue' },
  { hex: '#f2c94c', tw: 'yellow' },
  { hex: '#bb87fc', tw: 'purple' },
  { hex: '#4cb782', tw: 'green' },
  { hex: '#eb5757', tw: 'red' },
  { hex: '#f2994a', tw: 'orange' }
]

function hexDistance(a: string, b: string): number {
  const parse = (hex: string) => {
    const h = hex.replace('#', '')
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }
  const [r1, g1, b1] = parse(a)
  const [r2, g2, b2] = parse(b)
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2)
}

function normalizeIssue(issue: LinearIssueSummary): NormalizedIssue {
  const isTerminal = issue.state.type === 'completed' || issue.state.type === 'canceled'
  return {
    id: issue.id,
    key: issue.identifier,
    title: issue.title,
    description: issue.description,
    status: issue.state,
    updatedAt: issue.updatedAt,
    url: issue.url,
    isArchived: isTerminal || Boolean(issue.archivedAt),
    assignee: issue.assignee,
    extras: { priority: issue.priority }
  }
}

export const linearAdapter: ProviderAdapter = {
  provider: 'linear',

  async validateCredential(credential: string) {
    return getViewer(credential)
  },

  async listGroups(credential: string): Promise<ExternalGroup[]> {
    const { teams } = await listTeams(credential)
    return teams.map((t) => ({ id: t.id, key: t.key, name: t.name }))
  },

  async listScopes(credential: string, groupId: string): Promise<ExternalScope[]> {
    const projects = await listProjects(credential, groupId)
    return projects.map((p) => ({ id: p.id, name: p.name }))
  },

  async fetchStatuses(credential: string, groupId: string): Promise<ProviderStatus[]> {
    const states = await listWorkflowStates(credential, groupId)
    return states
      .sort((a, b) => a.position - b.position)
      .map((s) => ({ id: s.id, name: s.name, color: s.color, type: s.type, position: s.position }))
  },

  remoteStatusToCategory(status: ProviderStatus): WorkflowCategory {
    return LINEAR_TYPE_TO_CATEGORY[status.type ?? ''] ?? 'unstarted'
  },

  mapColor(color: string): string {
    let best = 'gray'
    let bestDist = Infinity
    for (const { hex, tw } of LINEAR_HEX_TO_TAILWIND) {
      const dist = hexDistance(color, hex)
      if (dist < bestDist) {
        bestDist = dist
        best = tw
      }
    }
    return best
  },

  async listIssues(credential: string, params: ListIssuesParams) {
    const data = await listIssues(credential, {
      teamId: params.groupId,
      projectId: params.scopeId,
      first: params.limit,
      after: params.cursor ?? null,
      updatedAfter: params.updatedAfter ?? null,
      assignedToMe: params.assignedToMe
    })
    return {
      issues: data.issues.map(normalizeIssue),
      nextCursor: data.nextCursor
    }
  },

  async getIssue(credential: string, externalId: string): Promise<NormalizedIssue | null> {
    const issue = await getIssue(credential, externalId)
    return issue ? normalizeIssue(issue) : null
  },

  async getIssuesBatch(credential: string, refs: IssueRef[]): Promise<Map<string, NormalizedIssue>> {
    const ids = refs.map((r) => r.id)
    const issueMap = await getIssuesBatch(credential, ids)
    const result = new Map<string, NormalizedIssue>()
    for (const [id, issue] of issueMap) {
      result.set(id, normalizeIssue(issue))
    }
    return result
  },

  async createIssue(credential: string, params: CreateIssueParams): Promise<NormalizedIssue> {
    const issue = await createIssue(credential, {
      teamId: params.groupId,
      title: params.title,
      description: params.description,
      priority: (params.extras?.priority as number) ?? undefined,
      stateId: params.statusId,
      projectId: params.scopeId
    })
    if (!issue) throw new Error('Failed to create Linear issue')
    return normalizeIssue(issue)
  },

  async updateIssue(
    credential: string,
    externalId: string,
    params: UpdateIssueParams
  ): Promise<NormalizedIssue | null> {
    const issue = await updateIssue(credential, externalId, {
      title: params.title,
      description: params.description,
      priority: (params.extras?.priority as number) ?? undefined,
      stateId: params.statusId,
      assigneeId: null
    })
    return issue ? normalizeIssue(issue) : null
  },

  parseExternalKey(): ExternalKeyContext | null {
    // Linear uses external_id directly, no routing info in key
    return null
  },

  buildExternalKey(issue: NormalizedIssue): string {
    return issue.key
  }
}
