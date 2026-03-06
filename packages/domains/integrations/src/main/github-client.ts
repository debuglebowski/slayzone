import type { GithubIssueSummary, GithubProjectSummary, GithubRepositorySummary } from '../shared'

const GITHUB_API_URL = 'https://api.github.com'
const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql'

interface GitHubError {
  message?: string
}

interface GitHubGraphQLError {
  message?: string
}

interface GitHubGraphQLResponse<T> {
  data?: T
  errors?: GitHubGraphQLError[]
}

interface GitHubUser {
  id: number
  login: string
  name: string | null
  email: string | null
}

interface GitHubRepository {
  id: number
  name: string
  full_name: string
  private: boolean
  owner: {
    login: string
  }
}

interface GitHubIssue {
  id: number
  number: number
  title: string
  body: string | null
  updated_at: string
  state: 'open' | 'closed'
  html_url: string
  assignee: {
    id: number
    login: string
  } | null
  labels: Array<{
    id: number
    name: string
  }>
  pull_request?: unknown
}

interface GitHubGraphQLOwner {
  __typename: 'User' | 'Organization'
  login: string
}

interface GitHubGraphQLProject {
  id: string
  number: number
  title: string
  url: string
  closed: boolean
  updatedAt: string
  owner: GitHubGraphQLOwner
}

interface GitHubGraphQLProjectListData {
  viewer: {
    projectsV2: {
      nodes: Array<GitHubGraphQLProject | null>
    }
    organizations: {
      nodes: Array<{
        projectsV2: {
          nodes: Array<GitHubGraphQLProject | null>
        }
      } | null>
    }
  }
}

interface GitHubGraphQLIssueNode {
  __typename: 'Issue'
  id: string
  number: number
  title: string
  body: string | null
  updatedAt: string
  state: 'OPEN' | 'CLOSED'
  url: string
  assignees: {
    nodes: Array<{
      id: string
      login: string
    }>
  }
  labels: {
    nodes: Array<{
      id: string
      name: string
    }>
  }
  repository: {
    name: string
    owner: {
      login: string
    }
  }
}

interface GitHubGraphQLPullRequestNode {
  __typename: 'PullRequest'
}

interface GitHubGraphQLProjectItemNode {
  content: GitHubGraphQLIssueNode | GitHubGraphQLPullRequestNode | null
}

interface GitHubGraphQLProjectIssuesData {
  node: {
    __typename: string
    items: {
      pageInfo: {
        hasNextPage: boolean
        endCursor: string | null
      }
      nodes: Array<GitHubGraphQLProjectItemNode | null>
    }
  } | null
}

function toSearchParams(query?: Record<string, string | number | boolean | null | undefined>): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue
    params.set(key, String(value))
  }
  const encoded = params.toString()
  return encoded ? `?${encoded}` : ''
}

async function requestGitHub<T>(
  token: string,
  path: string,
  query?: Record<string, string | number | boolean | null | undefined>,
  options?: {
    method?: 'GET' | 'PATCH' | 'POST'
    body?: Record<string, unknown> | null
  }
): Promise<T> {
  const res = await fetch(`${GITHUB_API_URL}${path}${toSearchParams(query)}`, {
    method: options?.method ?? 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'SlayZone',
      'Content-Type': 'application/json'
    },
    body: options?.body ? JSON.stringify(options.body) : undefined
  })

  if (!res.ok) {
    let detail = ''
    try {
      const body = await res.json() as GitHubError
      if (body.message) detail = body.message
    } catch {
      // Ignore JSON parsing failures.
    }
    throw new Error(`GitHub API request failed: HTTP ${res.status}${detail ? ` - ${detail}` : ''}`)
  }

  return await res.json() as T
}

async function requestGitHubGraphQL<T>(
  token: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const res = await fetch(GITHUB_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'SlayZone',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query,
      variables: variables ?? {}
    })
  })

  if (!res.ok) {
    let detail = ''
    try {
      const body = await res.json() as GitHubError
      if (body.message) detail = body.message
    } catch {
      // Ignore JSON parsing failures.
    }
    throw new Error(`GitHub GraphQL request failed: HTTP ${res.status}${detail ? ` - ${detail}` : ''}`)
  }

  const body = await res.json() as GitHubGraphQLResponse<T>
  if (body.errors?.length) {
    const first = body.errors.find((error) => Boolean(error.message))
    throw new Error(`GitHub GraphQL request failed${first?.message ? ` - ${first.message}` : ''}`)
  }
  if (!body.data) {
    throw new Error('GitHub GraphQL request failed: empty response')
  }
  return body.data
}

export async function getViewer(token: string): Promise<{
  workspaceId: string
  workspaceName: string
  accountLabel: string
}> {
  const viewer = await requestGitHub<GitHubUser>(token, '/user')
  return {
    workspaceId: String(viewer.id),
    workspaceName: viewer.login,
    accountLabel: viewer.email || viewer.name || viewer.login
  }
}

export async function listRepositories(token: string): Promise<GithubRepositorySummary[]> {
  const repositories: GithubRepositorySummary[] = []
  let page = 1
  const perPage = 100

  while (page <= 10) {
    const rows = await requestGitHub<GitHubRepository[]>(token, '/user/repos', {
      per_page: perPage,
      page,
      sort: 'updated',
      direction: 'desc',
      affiliation: 'owner,collaborator,organization_member'
    })

    for (const row of rows) {
      repositories.push({
        id: String(row.id),
        owner: row.owner.login,
        name: row.name,
        fullName: row.full_name,
        private: row.private
      })
    }

    if (rows.length < perPage) break
    page += 1
  }

  return repositories.sort((a, b) => a.fullName.localeCompare(b.fullName))
}

function mapProject(project: GitHubGraphQLProject): GithubProjectSummary {
  return {
    id: project.id,
    number: project.number,
    title: project.title,
    owner: {
      login: project.owner.login,
      type: project.owner.__typename === 'Organization' ? 'organization' : 'user'
    },
    url: project.url,
    closed: project.closed,
    updatedAt: project.updatedAt
  }
}

export async function listProjects(token: string): Promise<GithubProjectSummary[]> {
  const data = await requestGitHubGraphQL<GitHubGraphQLProjectListData>(
    token,
    `
      query ListProjects($projectFirst: Int!, $orgFirst: Int!) {
        viewer {
          projectsV2(first: $projectFirst, orderBy: { field: UPDATED_AT, direction: DESC }) {
            nodes {
              id
              number
              title
              url
              closed
              updatedAt
              owner {
                __typename
                ... on User { login }
                ... on Organization { login }
              }
            }
          }
          organizations(first: $orgFirst) {
            nodes {
              projectsV2(first: $projectFirst, orderBy: { field: UPDATED_AT, direction: DESC }) {
                nodes {
                  id
                  number
                  title
                  url
                  closed
                  updatedAt
                  owner {
                    __typename
                    ... on User { login }
                    ... on Organization { login }
                  }
                }
              }
            }
          }
        }
      }
    `,
    {
      projectFirst: 50,
      orgFirst: 30
    }
  )

  const byId = new Map<string, GithubProjectSummary>()
  for (const project of data.viewer.projectsV2.nodes ?? []) {
    if (!project) continue
    byId.set(project.id, mapProject(project))
  }
  for (const organization of data.viewer.organizations.nodes ?? []) {
    if (!organization) continue
    for (const project of organization.projectsV2.nodes ?? []) {
      if (!project) continue
      byId.set(project.id, mapProject(project))
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    const ownerCompare = a.owner.login.localeCompare(b.owner.login)
    if (ownerCompare !== 0) return ownerCompare
    return a.number - b.number
  })
}

function mapIssue(owner: string, repo: string, issue: GitHubIssue): GithubIssueSummary {
  return {
    id: String(issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    updatedAt: issue.updated_at,
    state: issue.state,
    assignee: issue.assignee
      ? {
          id: String(issue.assignee.id),
          login: issue.assignee.login
        }
      : null,
    labels: issue.labels.map((label) => ({
      id: String(label.id),
      name: label.name
    })),
    repository: {
      owner,
      name: repo,
      fullName: `${owner}/${repo}`
    },
    url: issue.html_url
  }
}

function mapGraphQLIssue(issue: GitHubGraphQLIssueNode): GithubIssueSummary {
  const owner = issue.repository.owner.login
  const repo = issue.repository.name
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    updatedAt: issue.updatedAt,
    state: issue.state === 'CLOSED' ? 'closed' : 'open',
    assignee: issue.assignees.nodes[0]
      ? {
          id: issue.assignees.nodes[0].id,
          login: issue.assignees.nodes[0].login
        }
      : null,
    labels: issue.labels.nodes.map((label) => ({
      id: label.id,
      name: label.name
    })),
    repository: {
      owner,
      name: repo,
      fullName: `${owner}/${repo}`
    },
    url: issue.url
  }
}

export async function listIssues(
  token: string,
  input: {
    owner: string
    repo: string
    limit: number
    cursor?: string | null
  }
): Promise<{ issues: GithubIssueSummary[]; nextCursor: string | null }> {
  const page = Math.max(1, Number.parseInt(input.cursor ?? '1', 10) || 1)
  const perPage = Math.max(1, Math.min(input.limit, 100))
  const owner = encodeURIComponent(input.owner)
  const repo = encodeURIComponent(input.repo)

  const rows = await requestGitHub<GitHubIssue[]>(
    token,
    `/repos/${owner}/${repo}/issues`,
    {
      state: 'all',
      per_page: perPage,
      page,
      sort: 'updated',
      direction: 'desc'
    }
  )

  const issues = rows
    .filter((row) => !row.pull_request)
    .map((row) => mapIssue(input.owner, input.repo, row))

  return {
    issues,
    nextCursor: rows.length === perPage ? String(page + 1) : null
  }
}

export async function getIssue(
  token: string,
  input: {
    owner: string
    repo: string
    number: number
  }
): Promise<GithubIssueSummary | null> {
  const owner = encodeURIComponent(input.owner)
  const repo = encodeURIComponent(input.repo)
  const issue = await requestGitHub<GitHubIssue>(
    token,
    `/repos/${owner}/${repo}/issues/${input.number}`
  )

  if (issue.pull_request) {
    return null
  }
  return mapIssue(input.owner, input.repo, issue)
}

export async function updateIssue(
  token: string,
  input: {
    owner: string
    repo: string
    number: number
    title: string
    body: string | null
    state: 'open' | 'closed'
  }
): Promise<GithubIssueSummary | null> {
  const owner = encodeURIComponent(input.owner)
  const repo = encodeURIComponent(input.repo)
  const issue = await requestGitHub<GitHubIssue>(
    token,
    `/repos/${owner}/${repo}/issues/${input.number}`,
    undefined,
    {
      method: 'PATCH',
      body: {
        title: input.title,
        body: input.body,
        state: input.state
      }
    }
  )

  if (issue.pull_request) {
    return null
  }
  return mapIssue(input.owner, input.repo, issue)
}

interface GitHubGraphQLProjectStatusFieldData {
  node: {
    __typename: string
    field: {
      __typename: string
      id: string
      options: Array<{
        id: string
        name: string
        color: string
      }>
    } | null
  } | null
}

export async function listProjectStatusOptions(
  token: string,
  projectId: string
): Promise<Array<{ id: string; name: string; color: string }>> {
  const data = await requestGitHubGraphQL<GitHubGraphQLProjectStatusFieldData>(
    token,
    `
      query ProjectStatusField($projectId: ID!) {
        node(id: $projectId) {
          __typename
          ... on ProjectV2 {
            field(name: "Status") {
              __typename
              ... on ProjectV2SingleSelectField {
                id
                options {
                  id
                  name
                  color
                }
              }
            }
          }
        }
      }
    `,
    { projectId }
  )

  if (!data.node || data.node.__typename !== 'ProjectV2') {
    throw new Error('GitHub project not found or inaccessible')
  }

  if (!data.node.field || data.node.field.__typename !== 'ProjectV2SingleSelectField') {
    return []
  }

  return data.node.field.options
}

export async function listProjectIssues(
  token: string,
  input: {
    projectId: string
    limit: number
    cursor?: string | null
  }
): Promise<{ issues: GithubIssueSummary[]; nextCursor: string | null }> {
  const perPage = Math.max(1, Math.min(input.limit, 100))
  const data = await requestGitHubGraphQL<GitHubGraphQLProjectIssuesData>(
    token,
    `
      query ListProjectIssues($projectId: ID!, $first: Int!, $after: String) {
        node(id: $projectId) {
          __typename
          ... on ProjectV2 {
            items(first: $first, after: $after) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                content {
                  __typename
                  ... on Issue {
                    id
                    number
                    title
                    body
                    updatedAt
                    state
                    url
                    assignees(first: 1) {
                      nodes {
                        id
                        login
                      }
                    }
                    labels(first: 20) {
                      nodes {
                        id
                        name
                      }
                    }
                    repository {
                      name
                      owner {
                        login
                      }
                    }
                  }
                  ... on PullRequest {
                    __typename
                  }
                }
              }
            }
          }
        }
      }
    `,
    {
      projectId: input.projectId,
      first: perPage,
      after: input.cursor ?? null
    }
  )

  if (!data.node || data.node.__typename !== 'ProjectV2') {
    throw new Error('GitHub project not found or inaccessible')
  }

  const issues: GithubIssueSummary[] = []
  const seen = new Set<string>()
  for (const item of data.node.items.nodes) {
    if (!item) continue
    if (!item.content || item.content.__typename !== 'Issue') continue
    const mapped = mapGraphQLIssue(item.content)
    if (seen.has(mapped.id)) continue
    seen.add(mapped.id)
    issues.push(mapped)
  }

  return {
    issues,
    nextCursor: data.node.items.pageInfo.hasNextPage ? data.node.items.pageInfo.endCursor : null
  }
}
