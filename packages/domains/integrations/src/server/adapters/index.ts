import { registerAdapter, getAdapter, getRegisteredProviders } from './registry'
import { linearAdapter } from './linear-adapter'
import { githubAdapter } from './github-adapter'
import { jiraAdapter } from './jira-adapter'

// Register built-in adapters
registerAdapter(linearAdapter)
registerAdapter(githubAdapter)
registerAdapter(jiraAdapter)

export { getAdapter, getRegisteredProviders, registerAdapter }
export type {
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
export { parseGitHubExternalKey, normalizeGithubIssue } from './github-adapter'
