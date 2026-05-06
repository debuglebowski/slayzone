import type { IntegrationProvider, ProviderStatus } from '../../shared'
import type { WorkflowCategory } from '@slayzone/workflow'

// Re-export shared types so existing adapter consumers don't break
export type { NormalizedIssue, ExternalGroup, ExternalScope } from '../../shared'
import type { NormalizedIssue, ExternalGroup, ExternalScope } from '../../shared'

/** Opaque context parsed from an external_key (e.g. GitHub: { owner, repo, number }) */
export type ExternalKeyContext = Record<string, unknown>

export interface IssueRef {
  id: string
  context?: ExternalKeyContext
}

export interface ListIssuesParams {
  groupId: string
  scopeId?: string
  limit: number
  cursor?: string | null
  updatedAfter?: string | null
  assignedToMe?: boolean
}

export interface CreateIssueParams {
  groupId: string
  scopeId?: string | null
  title: string
  description?: string | null
  statusId?: string
  extras?: Record<string, unknown>
}

export interface UpdateIssueParams {
  title?: string
  description?: string | null
  statusId?: string
  extras?: Record<string, unknown>
}

export interface ProviderAdapter {
  readonly provider: IntegrationProvider

  // -- Connection --
  validateCredential(credential: string): Promise<{
    workspaceId: string
    workspaceName: string
    accountLabel: string
  }>

  // -- Structure discovery --
  listGroups(credential: string): Promise<ExternalGroup[]>
  listScopes(credential: string, groupId: string): Promise<ExternalScope[]>

  // -- Status --
  fetchStatuses(credential: string, groupId: string, scopeId?: string): Promise<ProviderStatus[]>
  remoteStatusToCategory(status: ProviderStatus): WorkflowCategory
  mapColor(color: string): string

  // -- Issues --
  listIssues(
    credential: string,
    params: ListIssuesParams
  ): Promise<{ issues: NormalizedIssue[]; nextCursor: string | null }>

  getIssue(
    credential: string,
    externalId: string,
    ctx?: ExternalKeyContext
  ): Promise<NormalizedIssue | null>

  getIssuesBatch(
    credential: string,
    refs: IssueRef[]
  ): Promise<Map<string, NormalizedIssue>>

  createIssue(
    credential: string,
    params: CreateIssueParams
  ): Promise<NormalizedIssue>

  updateIssue(
    credential: string,
    externalId: string,
    params: UpdateIssueParams,
    ctx?: ExternalKeyContext
  ): Promise<NormalizedIssue | null>

  // -- Key handling --
  /** Parse routing info from external_key. Returns null if provider uses external_id directly. */
  parseExternalKey(key: string): ExternalKeyContext | null
  buildExternalKey(issue: NormalizedIssue): string
}
