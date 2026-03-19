/**
 * JIRA Cloud REST API v3 client.
 * Auth: Basic auth (email:apiToken base64-encoded).
 * Credential format: JSON string { token: string, domain: string }
 */

interface JiraCredential {
  token: string   // base64(email:apiToken)
  domain: string  // e.g. "company.atlassian.net"
}

export function parseJiraCredential(credential: string): JiraCredential {
  const parsed = JSON.parse(credential) as JiraCredential
  if (!parsed.token || !parsed.domain) {
    throw new Error('Invalid Jira credential: missing token or domain')
  }
  return parsed
}

export function buildJiraCredential(email: string, apiToken: string, domain: string): string {
  const token = Buffer.from(`${email}:${apiToken}`).toString('base64')
  // Strip protocol, trailing slashes, and paths so only the hostname remains
  const cleanDomain = domain
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
  return JSON.stringify({ token, domain: cleanDomain })
}

async function requestJira<T>(
  credential: string,
  path: string,
  options?: {
    method?: 'GET' | 'POST' | 'PUT'
    body?: unknown
    query?: Record<string, string | number>
  }
): Promise<T> {
  const { token, domain } = parseJiraCredential(credential)
  const url = new URL(`https://${domain}${path}`)
  if (options?.query) {
    for (const [key, value] of Object.entries(options.query)) {
      url.searchParams.set(key, String(value))
    }
  }

  let res: Response
  try {
    res = await fetch(url.toString(), {
      method: options?.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${token}`,
        Accept: 'application/json'
      },
      body: options?.body ? JSON.stringify(options.body) : undefined
    })
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not reach ${domain} — check that the domain is correct and you're online (${cause})`)
  }

  if (!res.ok) {
    let detail = ''
    try {
      const body = await res.json() as { errorMessages?: string[]; message?: string }
      detail = body.errorMessages?.join('; ') ?? body.message ?? ''
    } catch {
      // ignore
    }
    throw new Error(`Jira API request failed: HTTP ${res.status}${detail ? ` - ${detail}` : ''}`)
  }

  if (res.status === 204) return undefined as T
  return await res.json() as T
}

// --- Types ---

interface JiraUser {
  accountId: string
  displayName: string
  emailAddress: string
}

interface JiraProject {
  id: string
  key: string
  name: string
}

interface JiraStatus {
  id: string
  name: string
  statusCategory: {
    id: number
    key: string
    name: string
    colorName: string
  }
}

interface JiraIssueFields {
  summary: string
  description: unknown // ADF
  status: JiraStatus
  updated: string
  assignee: JiraUser | null
  issuetype: { name: string }
  project: { key: string }
}

interface JiraIssue {
  id: string
  key: string
  self: string
  fields: JiraIssueFields
}

interface JiraSearchResult {
  issues: JiraIssue[]
  nextPageToken?: string | null
  total: number
}

interface JiraTransitionResponse {
  transitions: Array<{
    id: string
    name: string
    to: {
      id: string
      name: string
      statusCategory: { key: string }
    }
  }>
}

// --- Exported types ---

export interface JiraIssueSummary {
  id: string
  key: string
  summary: string
  description: unknown // ADF object
  status: { id: string; name: string; categoryKey: string }
  updatedAt: string
  assignee: { accountId: string; displayName: string } | null
  issueType: string
  projectKey: string
}

export interface JiraTransitionInfo {
  id: string
  name: string
  to: { id: string; name: string; categoryKey: string }
}

// --- API functions ---

export async function getViewer(credential: string): Promise<{
  workspaceId: string
  workspaceName: string
  accountLabel: string
}> {
  const { domain } = parseJiraCredential(credential)
  const user = await requestJira<JiraUser>(credential, '/rest/api/3/myself')
  return {
    workspaceId: domain,
    workspaceName: domain.replace('.atlassian.net', ''),
    accountLabel: user.emailAddress || user.displayName
  }
}

export async function listProjects(credential: string): Promise<JiraProject[]> {
  const projects: JiraProject[] = []
  let startAt = 0
  const maxResults = 50

  while (startAt < 500) {
    const data = await requestJira<{ values: JiraProject[]; total: number }>(
      credential,
      '/rest/api/3/project/search',
      { query: { startAt, maxResults } }
    )
    projects.push(...data.values)
    if (projects.length >= data.total || data.values.length < maxResults) break
    startAt += maxResults
  }

  return projects.sort((a, b) => a.key.localeCompare(b.key))
}

export async function listStatuses(credential: string): Promise<JiraStatus[]> {
  const data = await requestJira<JiraStatus[]>(credential, '/rest/api/3/status')
  // Deduplicate by name (JIRA returns statuses per issue type)
  const seen = new Map<string, JiraStatus>()
  for (const status of data) {
    if (!seen.has(status.name)) {
      seen.set(status.name, status)
    }
  }
  return [...seen.values()]
}

function mapIssue(issue: JiraIssue): JiraIssueSummary {
  return {
    id: issue.id,
    key: issue.key,
    summary: issue.fields.summary,
    description: issue.fields.description,
    status: {
      id: issue.fields.status.id,
      name: issue.fields.status.name,
      categoryKey: issue.fields.status.statusCategory.key
    },
    updatedAt: issue.fields.updated,
    assignee: issue.fields.assignee
      ? { accountId: issue.fields.assignee.accountId, displayName: issue.fields.assignee.displayName }
      : null,
    issueType: issue.fields.issuetype.name,
    projectKey: issue.fields.project.key
  }
}

export async function searchIssues(
  credential: string,
  jql: string,
  limit: number,
  nextPageToken?: string | null
): Promise<{ issues: JiraIssueSummary[]; nextPageToken: string | null }> {
  const body: Record<string, unknown> = {
    jql,
    maxResults: Math.min(limit, 100),
    fields: ['summary', 'description', 'status', 'updated', 'assignee', 'issuetype', 'project']
  }
  if (nextPageToken) {
    body.nextPageToken = nextPageToken
  }

  const data = await requestJira<JiraSearchResult>(credential, '/rest/api/3/search/jql', {
    method: 'POST',
    body
  })

  return {
    issues: data.issues.map((issue) => mapIssue(issue)),
    nextPageToken: data.nextPageToken ?? null
  }
}

export async function getIssue(credential: string, issueKey: string): Promise<JiraIssueSummary | null> {
  try {
    const issue = await requestJira<JiraIssue>(
      credential,
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
      { query: { fields: 'summary,description,status,updated,assignee,issuetype,project' } }
    )
    return mapIssue(issue)
  } catch (err) {
    if (err instanceof Error && err.message.includes('HTTP 404')) return null
    throw err
  }
}

export async function createIssue(
  credential: string,
  input: {
    projectKey: string
    summary: string
    description?: unknown // ADF
    issueType?: string
  }
): Promise<JiraIssueSummary> {
  const fields: Record<string, unknown> = {
    project: { key: input.projectKey },
    summary: input.summary,
    issuetype: { name: input.issueType ?? 'Task' }
  }
  if (input.description) {
    fields.description = input.description
  }

  const created = await requestJira<{ id: string; key: string }>(credential, '/rest/api/3/issue', {
    method: 'POST',
    body: { fields }
  })

  // Fetch full issue to get status, updated, etc.
  const issue = await getIssue(credential, created.key)
  if (!issue) throw new Error(`Created issue ${created.key} but could not fetch it`)
  return issue
}

export async function updateIssue(
  credential: string,
  issueKey: string,
  input: { summary?: string; description?: unknown }
): Promise<JiraIssueSummary | null> {
  const fields: Record<string, unknown> = {}
  if (input.summary !== undefined) fields.summary = input.summary
  if (input.description !== undefined) fields.description = input.description

  if (Object.keys(fields).length > 0) {
    await requestJira<void>(
      credential,
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
      { method: 'PUT', body: { fields } }
    )
  }

  return getIssue(credential, issueKey)
}

export async function getTransitions(credential: string, issueKey: string): Promise<JiraTransitionInfo[]> {
  const data = await requestJira<JiraTransitionResponse>(
    credential,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`
  )
  return data.transitions.map((t) => ({
    id: t.id,
    name: t.name,
    to: {
      id: t.to.id,
      name: t.to.name,
      categoryKey: t.to.statusCategory.key
    }
  }))
}

export async function transitionIssue(
  credential: string,
  issueKey: string,
  transitionId: string
): Promise<void> {
  await requestJira<void>(
    credential,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    { method: 'POST', body: { transition: { id: transitionId } } }
  )
}
