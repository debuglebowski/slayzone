import type { ProviderStatus } from '../../shared'
import type { WorkflowCategory } from '@slayzone/workflow'
import {
  getViewer,
  listProjects,
  listStatuses,
  searchIssues,
  getIssue,
  createIssue,
  updateIssue,
  getTransitions,
  transitionIssue
} from '../jira-client'
import type { JiraIssueSummary } from '../jira-client'
import { adfToMarkdown, markdownToAdf } from '../adf-markdown'
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

const JIRA_CATEGORY_MAP: Record<string, WorkflowCategory> = {
  new: 'unstarted',
  indeterminate: 'started',
  done: 'completed',
  undefined: 'unstarted'
}

const JIRA_COLOR_MAP: Record<string, string> = {
  'blue-gray': 'gray',
  yellow: 'yellow',
  green: 'green',
  'medium-gray': 'slate',
  default: 'gray'
}

function normalizeIssue(issue: JiraIssueSummary, domain: string): NormalizedIssue {
  return {
    id: issue.id,
    key: issue.key,
    title: issue.summary,
    description: issue.description ? adfToMarkdown(issue.description) : null,
    status: {
      id: issue.status.id,
      name: issue.status.name,
      type: issue.status.categoryKey
    },
    updatedAt: issue.updatedAt,
    url: `https://${domain}/browse/${issue.key}`,
    isArchived: issue.status.categoryKey === 'done',
    assignee: issue.assignee
      ? { id: issue.assignee.accountId, name: issue.assignee.displayName }
      : null,
    extras: { issueType: issue.issueType }
  }
}

function getDomain(credential: string): string {
  const { domain } = JSON.parse(credential) as { domain: string }
  return domain
}

export const jiraAdapter: ProviderAdapter = {
  provider: 'jira',

  async validateCredential(credential: string) {
    return getViewer(credential)
  },

  async listGroups(credential: string): Promise<ExternalGroup[]> {
    const projects = await listProjects(credential)
    return projects.map((p) => ({ id: p.id, key: p.key, name: `${p.key} - ${p.name}` }))
  },

  async listScopes(): Promise<ExternalScope[]> {
    return []
  },

  async fetchStatuses(credential: string): Promise<ProviderStatus[]> {
    const statuses = await listStatuses(credential)
    return statuses.map((s, i) => ({
      id: s.id,
      name: s.name,
      color: s.statusCategory.colorName,
      type: s.statusCategory.key,
      position: i
    }))
  },

  remoteStatusToCategory(status: ProviderStatus): WorkflowCategory {
    return JIRA_CATEGORY_MAP[status.type ?? ''] ?? 'unstarted'
  },

  mapColor(color: string): string {
    return JIRA_COLOR_MAP[color.toLowerCase()] ?? 'gray'
  },

  async listIssues(credential: string, params: ListIssuesParams) {
    const jql = `project = "${params.groupId}" ORDER BY updated DESC`
    const data = await searchIssues(credential, jql, params.limit, params.cursor)
    const domain = getDomain(credential)
    return {
      issues: data.issues.map((issue) => normalizeIssue(issue, domain)),
      nextCursor: data.nextPageToken
    }
  },

  async getIssue(credential: string, externalId: string): Promise<NormalizedIssue | null> {
    const issue = await getIssue(credential, externalId)
    if (!issue) return null
    return normalizeIssue(issue, getDomain(credential))
  },

  async getIssuesBatch(credential: string, refs: IssueRef[]): Promise<Map<string, NormalizedIssue>> {
    if (refs.length === 0) return new Map()
    // Use JQL key IN (...) for batch fetch
    const keys = refs.map((r) => `"${r.id}"`).join(', ')
    const jql = `key IN (${keys})`
    const data = await searchIssues(credential, jql, refs.length)
    const domain = getDomain(credential)
    const result = new Map<string, NormalizedIssue>()
    for (const issue of data.issues) {
      // Match by issue.id (numeric) since that's what external_id stores
      result.set(issue.id, normalizeIssue(issue, domain))
    }
    return result
  },

  async createIssue(credential: string, params: CreateIssueParams): Promise<NormalizedIssue> {
    const issue = await createIssue(credential, {
      projectKey: params.groupId,
      summary: params.title,
      description: params.description ? markdownToAdf(params.description) : undefined,
      issueType: (params.extras?.issueType as string) ?? 'Task'
    })
    return normalizeIssue(issue, getDomain(credential))
  },

  async updateIssue(
    credential: string,
    externalId: string,
    params: UpdateIssueParams
  ): Promise<NormalizedIssue | null> {
    // Update fields (summary, description)
    const updated = await updateIssue(credential, externalId, {
      summary: params.title,
      description: params.description !== undefined
        ? (params.description ? markdownToAdf(params.description) : null)
        : undefined
    })

    // Handle status transition if statusId provided
    if (params.statusId) {
      const transitions = await getTransitions(credential, externalId)
      const matching = transitions.filter((t) => t.to.id === params.statusId)

      if (matching.length === 1) {
        await transitionIssue(credential, externalId, matching[0].id)
      } else if (matching.length > 1) {
        // Ambiguous — check if explicit transitionId provided
        const explicitId = params.extras?.transitionId as string | undefined
        if (explicitId) {
          await transitionIssue(credential, externalId, explicitId)
        } else {
          // Flag ambiguity for UI to resolve
          const refreshed = await getIssue(credential, externalId)
          if (refreshed) {
            const normalized = normalizeIssue(refreshed, getDomain(credential))
            normalized.extras.ambiguousTransitions = matching
            return normalized
          }
        }
      }
      // If no matching transitions, skip silently (status may already be correct)
    }

    if (!updated) return null
    // Re-fetch to get updated status after potential transition
    const refreshed = await getIssue(credential, externalId)
    return refreshed ? normalizeIssue(refreshed, getDomain(credential)) : null
  },

  parseExternalKey(): ExternalKeyContext | null {
    return null
  },

  buildExternalKey(issue: NormalizedIssue): string {
    return issue.key
  }
}
