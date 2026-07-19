import type { AuthorContext } from '@slayzone/task-artifacts/shared'

/**
 * Author context for CLI-written artifacts/comments. The CLI runs inside an
 * agent's terminal, where SlayZone injects the agent identity as
 * `SLAYZONE_AGENT_ID` (the mode string — see terminal/server/mcp-env.ts, which
 * sets `env.SLAYZONE_AGENT_ID = mode`). Reading that var tags the action as
 * agent-authored; absent it (a human shell), the author is the user.
 *
 * Kept in its own module (type-only import) so it stays decoupled from the CLI
 * DB/api graph and unit-testable.
 */
export function cliAuthor(): AuthorContext {
  const agentId = process.env.SLAYZONE_AGENT_ID
  if (agentId) return { type: 'agent', id: agentId }
  return { type: 'user', id: null }
}
