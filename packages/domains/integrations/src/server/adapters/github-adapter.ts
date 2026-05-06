import type { ProviderStatus } from '../../shared'
import type { WorkflowCategory } from '@slayzone/workflow'
import {
  getViewer,
  listRepositories,
  listProjects,
  listProjectStatusOptions,
  listProjectIssues,
  listIssues as listRepoIssues,
  getIssue,
  getIssuesBatch,
  createIssue,
  updateIssue
} from '../github-client'
import type { GithubIssueSummary } from '../../shared'
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

const GITHUB_NAME_HEURISTICS: Array<{ pattern: RegExp; category: WorkflowCategory }> = [
  { pattern: /^done$|^closed$|^complete[d]?$|^merged$/i, category: 'completed' },
  { pattern: /^cancel[led]*$|^won'?t\s*(do|fix)$/i, category: 'canceled' },
  { pattern: /^in\s*progress$|^in\s*review$|^review$|^active$/i, category: 'started' },
  { pattern: /^todo$|^to\s*do$|^ready$|^new$/i, category: 'unstarted' },
  { pattern: /^backlog$/i, category: 'backlog' },
  { pattern: /^triage$|^inbox$/i, category: 'triage' }
]

const GITHUB_COLOR_TO_TAILWIND: Record<string, string> = {
  GREEN: 'green',
  YELLOW: 'yellow',
  ORANGE: 'orange',
  RED: 'red',
  PINK: 'red',
  PURPLE: 'purple',
  BLUE: 'blue',
  GRAY: 'gray'
}

export interface GitHubExternalKeyContext extends Record<string, unknown> {
  owner: string
  repo: string
  number: number
}

export function parseGitHubExternalKey(externalKey: string): GitHubExternalKeyContext | null {
  const match = externalKey.match(/^([^/]+)\/([^#]+)#(\d+)$/)
  if (!match) return null
  const number = Number.parseInt(match[3], 10)
  if (!Number.isFinite(number)) return null
  return { owner: match[1], repo: match[2], number }
}

export function normalizeGithubIssue(issue: GithubIssueSummary): NormalizedIssue {
  return {
    id: issue.id,
    key: `${issue.repository.fullName}#${issue.number}`,
    title: issue.title,
    description: issue.body,
    status: {
      id: issue.state,
      name: issue.state,
      type: issue.state
    },
    updatedAt: issue.updatedAt,
    url: issue.url,
    isArchived: issue.state === 'closed',
    assignee: issue.assignee
      ? { id: issue.assignee.id, name: issue.assignee.login }
      : null,
    extras: {
      labels: issue.labels,
      number: issue.number,
      repository: issue.repository
    }
  }
}

export const githubAdapter: ProviderAdapter = {
  provider: 'github',

  async validateCredential(credential: string) {
    return getViewer(credential)
  },

  async listGroups(credential: string): Promise<ExternalGroup[]> {
    const repos = await listRepositories(credential)
    return repos.map((r) => ({
      id: r.id,
      key: r.fullName,
      name: r.fullName
    }))
  },

  async listScopes(credential: string): Promise<ExternalScope[]> {
    const projects = await listProjects(credential)
    return projects.map((p) => ({
      id: p.id,
      name: `${p.owner.login}/${p.title} (#${p.number})`
    }))
  },

  async fetchStatuses(credential: string, _groupId: string, scopeId?: string): Promise<ProviderStatus[]> {
    if (!scopeId) throw new Error('externalProjectId required for GitHub')
    const options = await listProjectStatusOptions(credential, scopeId)
    return options.map((o, i) => ({ id: o.id, name: o.name, color: o.color, position: i }))
  },

  remoteStatusToCategory(status: ProviderStatus): WorkflowCategory {
    for (const { pattern, category } of GITHUB_NAME_HEURISTICS) {
      if (pattern.test(status.name.trim())) return category
    }
    return 'unstarted'
  },

  mapColor(color: string): string {
    return GITHUB_COLOR_TO_TAILWIND[color.toUpperCase()] ?? 'gray'
  },

  async listIssues(credential: string, params: ListIssuesParams) {
    if (params.scopeId) {
      // List from GitHub Project
      const data = await listProjectIssues(credential, {
        projectId: params.scopeId,
        limit: params.limit,
        cursor: params.cursor ?? null
      })
      return {
        issues: data.issues.map(normalizeGithubIssue),
        nextCursor: data.nextCursor
      }
    }
    // List from repository (groupId = "owner/repo")
    const [owner, repo] = params.groupId.split('/')
    if (!owner || !repo) throw new Error('groupId must be owner/repo for GitHub')
    const data = await listRepoIssues(credential, {
      owner,
      repo,
      limit: params.limit,
      cursor: params.cursor ?? null,
      since: params.updatedAfter ?? null
    })
    return {
      issues: data.issues.map(normalizeGithubIssue),
      nextCursor: data.nextCursor
    }
  },

  async getIssue(
    credential: string,
    _externalId: string,
    ctx?: ExternalKeyContext
  ): Promise<NormalizedIssue | null> {
    const key = ctx as GitHubExternalKeyContext | undefined
    if (!key?.owner || !key?.repo || !key?.number) {
      throw new Error('GitHub getIssue requires ExternalKeyContext with owner, repo, number')
    }
    const issue = await getIssue(credential, key)
    return issue ? normalizeGithubIssue(issue) : null
  },

  async getIssuesBatch(credential: string, refs: IssueRef[]): Promise<Map<string, NormalizedIssue>> {
    const batchInput = refs
      .map((ref) => {
        const ctx = ref.context as GitHubExternalKeyContext | undefined
        if (!ctx?.owner || !ctx?.repo || !ctx?.number) return null
        return { id: ref.id, owner: ctx.owner, repo: ctx.repo, number: ctx.number }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)

    const issueMap = await getIssuesBatch(credential, batchInput)
    const result = new Map<string, NormalizedIssue>()
    for (const [id, issue] of issueMap) {
      result.set(id, normalizeGithubIssue(issue))
    }
    return result
  },

  async createIssue(credential: string, params: CreateIssueParams): Promise<NormalizedIssue> {
    const [owner, repo] = params.groupId.split('/')
    if (!owner || !repo) throw new Error('groupId must be owner/repo for GitHub')
    const issue = await createIssue(credential, {
      owner,
      repo,
      title: params.title,
      body: params.description
    })
    return normalizeGithubIssue(issue)
  },

  async updateIssue(
    credential: string,
    _externalId: string,
    params: UpdateIssueParams,
    ctx?: ExternalKeyContext
  ): Promise<NormalizedIssue | null> {
    const key = ctx as GitHubExternalKeyContext | undefined
    if (!key?.owner || !key?.repo || !key?.number) {
      throw new Error('GitHub updateIssue requires ExternalKeyContext with owner, repo, number')
    }
    const issue = await updateIssue(credential, {
      owner: key.owner,
      repo: key.repo,
      number: key.number,
      title: params.title ?? '',
      body: params.description ?? null,
      state: (params.extras?.state as 'open' | 'closed') ?? 'open'
    })
    return issue ? normalizeGithubIssue(issue) : null
  },

  parseExternalKey(key: string): ExternalKeyContext | null {
    return parseGitHubExternalKey(key)
  },

  buildExternalKey(issue: NormalizedIssue): string {
    return issue.key
  }
}
