/**
 * `terminalMode` → `agentId` body alias, shared by the REST routes and MCP tools.
 *
 * The task's agent field was called `terminalMode` until the "terminal mode" →
 * "agent" rename. Older CLIs, scripts and MCP callers still send the old name, so
 * every write path that takes the field accepts BOTH: `agentId` is canonical,
 * `terminalMode` is a deprecated alias. Giving both with different values is a
 * contradiction, refused rather than resolved by a silent precedence rule.
 *
 * Mutates `body`: on success the value (if any) sits on `agentId` and
 * `terminalMode` is gone, so a strict domain schema never sees the old key.
 */
export function resolveAgentIdAlias(
  body: Record<string, unknown>
): { ok: true } | { ok: false; error: string } {
  if (!('terminalMode' in body)) return { ok: true }
  const legacy = body.terminalMode
  delete body.terminalMode
  if (legacy === undefined) return { ok: true }
  if (body.agentId !== undefined && body.agentId !== legacy) {
    return {
      ok: false,
      error:
        'Use agentId (terminalMode is its deprecated old name), not both with different values.'
    }
  }
  body.agentId = legacy
  return { ok: true }
}
