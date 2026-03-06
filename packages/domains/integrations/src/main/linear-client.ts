import type { LinearIssueSummary, LinearProject, LinearTeam } from '../shared'

const LINEAR_API_URL = 'https://api.linear.app/graphql'

interface GraphQLResponse<T> {
  data?: T
  errors?: Array<{ message: string }>
}

interface ViewerQuery {
  viewer: {
    id: string
    name: string
    email: string
  }
  organization: {
    id: string
    name: string
  }
}

interface TeamsQuery {
  teams: {
    nodes: Array<{ id: string; key: string; name: string }>
  }
}

interface TeamProjectsQuery {
  team: {
    projects: {
      nodes: Array<{ id: string; name: string }>
    }
  } | null
}

interface WorkflowStatesQuery {
  workflowStates: {
    nodes: Array<{
      id: string
      name: string
      type: string
      color: string
      position: number
      team: { id: string } | null
    }>
  }
}

interface IssuesQuery {
  issues: {
    pageInfo: {
      hasNextPage: boolean
      endCursor: string | null
    }
    nodes: Array<{
      id: string
      identifier: string
      title: string
      description: string | null
      priority: number | null
      updatedAt: string
      url: string
      state: { id: string; name: string; type: string }
      assignee: { id: string; name: string } | null
      team: { id: string; key: string; name: string }
      project: { id: string; name: string } | null
    }>
  }
}

interface TeamIssuesQuery {
  team: {
    issues: IssuesQuery['issues']
  } | null
}

interface ProjectIssuesQuery {
  project: {
    issues: IssuesQuery['issues']
  } | null
}

interface IssueQuery {
  issue: {
    id: string
    identifier: string
    title: string
    description: string | null
    priority: number | null
    updatedAt: string
    url: string
    state: { id: string; name: string; type: string }
    assignee: { id: string; name: string } | null
    team: { id: string; key: string; name: string }
    project: { id: string; name: string } | null
  } | null
}

interface UpdateIssueMutation {
  issueUpdate: {
    success: boolean
    issue: IssueQuery['issue']
  }
}

async function requestLinear<T>(apiKey: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(LINEAR_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey
    },
    body: JSON.stringify({ query, variables })
  })

  if (!res.ok) {
    const bodyText = await res.text()
    throw new Error(`Linear API request failed: HTTP ${res.status}${bodyText ? ` - ${bodyText}` : ''}`)
  }

  const body = await res.json() as GraphQLResponse<T>
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join('; '))
  }
  if (!body.data) {
    throw new Error('Linear API returned no data')
  }
  return body.data
}

function mapIssue(issue: NonNullable<IssueQuery['issue']>): LinearIssueSummary {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority ?? 0,
    updatedAt: issue.updatedAt,
    state: issue.state,
    assignee: issue.assignee,
    team: issue.team,
    project: issue.project,
    url: issue.url
  }
}

export async function getViewer(apiKey: string): Promise<{ workspaceId: string; workspaceName: string; accountLabel: string }> {
  const data = await requestLinear<ViewerQuery>(
    apiKey,
    `query ViewerAndOrg {
      viewer { id name email }
      organization { id name }
    }`
  )

  return {
    workspaceId: data.organization.id,
    workspaceName: data.organization.name,
    accountLabel: data.viewer.email || data.viewer.name
  }
}

export async function listTeams(apiKey: string): Promise<LinearTeam[]> {
  const data = await requestLinear<TeamsQuery>(
    apiKey,
    `query Teams {
      teams { nodes { id key name } }
    }`
  )
  return data.teams.nodes
}

export async function listProjects(apiKey: string, teamId: string): Promise<LinearProject[]> {
  const data = await requestLinear<TeamProjectsQuery>(
    apiKey,
    `query TeamProjects($teamId: String!) {
      team(id: $teamId) {
        projects {
          nodes { id name }
        }
      }
    }`,
    { teamId }
  )
  if (!data.team) return []
  return data.team.projects.nodes.map((p) => ({ id: p.id, name: p.name, teamId }))
}

export async function listWorkflowStates(
  apiKey: string,
  teamId: string
): Promise<Array<{ id: string; name: string; type: string; color: string; position: number }>> {
  const data = await requestLinear<WorkflowStatesQuery>(
    apiKey,
    `query WorkflowStates($teamId: ID!) {
      workflowStates(filter: { team: { id: { eq: $teamId } } }) {
        nodes { id name type color position team { id } }
      }
    }`,
    { teamId }
  )

  return data.workflowStates.nodes
    .filter((state) => state.team?.id === teamId)
    .map((state) => ({ id: state.id, name: state.name, type: state.type, color: state.color, position: state.position }))
}

export async function listIssues(
  apiKey: string,
  input: { teamId?: string; projectId?: string; first: number; after?: string | null }
): Promise<{ issues: LinearIssueSummary[]; nextCursor: string | null }> {
  const variables: Record<string, unknown> = {
    first: input.first,
    after: input.after ?? null
  }

  if (input.projectId) {
    variables.projectId = input.projectId

    const data = await requestLinear<ProjectIssuesQuery>(
      apiKey,
      `query ProjectIssues($projectId: String!, $first: Int!, $after: String) {
      project(id: $projectId) {
        issues(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id identifier title description priority updatedAt url
            state { id name type }
            assignee { id name }
            team { id key name }
            project { id name }
          }
        }
      }
    }`,
      variables
    )

    const issuesConnection = data.project?.issues
    if (!issuesConnection) {
      return { issues: [], nextCursor: null }
    }

    return {
      issues: issuesConnection.nodes.map((issue) => mapIssue(issue)),
      nextCursor: issuesConnection.pageInfo.hasNextPage ? issuesConnection.pageInfo.endCursor : null
    }
  }

  if (input.teamId) {
    variables.teamId = input.teamId

    const data = await requestLinear<TeamIssuesQuery>(
      apiKey,
      `query TeamIssues($teamId: String!, $first: Int!, $after: String) {
      team(id: $teamId) {
        issues(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id identifier title description priority updatedAt url
            state { id name type }
            assignee { id name }
            team { id key name }
            project { id name }
          }
        }
      }
    }`,
      variables
    )

    const issuesConnection = data.team?.issues
    if (!issuesConnection) {
      return { issues: [], nextCursor: null }
    }

    return {
      issues: issuesConnection.nodes.map((issue) => mapIssue(issue)),
      nextCursor: issuesConnection.pageInfo.hasNextPage ? issuesConnection.pageInfo.endCursor : null
    }
  }

  const data = await requestLinear<IssuesQuery>(
    apiKey,
    `query Issues($first: Int!, $after: String) {
      issues(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id identifier title description priority updatedAt url
          state { id name type }
          assignee { id name }
          team { id key name }
          project { id name }
        }
      }
    }`,
    variables
  )

  return {
    issues: data.issues.nodes.map((issue) => mapIssue(issue)),
    nextCursor: data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null
  }
}

export async function getIssue(apiKey: string, issueId: string): Promise<LinearIssueSummary | null> {
  const data = await requestLinear<IssueQuery>(
    apiKey,
    `query Issue($issueId: String!) {
      issue(id: $issueId) {
        id identifier title description priority updatedAt url
        state { id name type }
        assignee { id name }
        team { id key name }
        project { id name }
      }
    }`,
    { issueId }
  )

  if (!data.issue) return null
  return mapIssue(data.issue)
}

export async function updateIssue(
  apiKey: string,
  issueId: string,
  input: {
    title?: string
    description?: string | null
    priority?: number
    stateId?: string
    assigneeId?: string | null
  }
): Promise<LinearIssueSummary | null> {
  const data = await requestLinear<UpdateIssueMutation>(
    apiKey,
    `mutation UpdateIssue($issueId: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $issueId, input: $input) {
        success
        issue {
          id identifier title description priority updatedAt url
          state { id name type }
          assignee { id name }
          team { id key name }
          project { id name }
        }
      }
    }`,
    {
      issueId,
      input
    }
  )

  if (!data.issueUpdate.success || !data.issueUpdate.issue) {
    return null
  }

  return mapIssue(data.issueUpdate.issue)
}
