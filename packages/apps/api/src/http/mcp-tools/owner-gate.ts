import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { SlayzoneDb } from '@slayzone/platform'
import { runAsSecurityActor } from '@slayzone/platform/security-log'
import { createAccessScope } from '../../access'
import { MCP_ADMIN_POLICY, type AccessClass } from '../../admin-policy'
import { getAuthGate } from '@slayzone/trpc-server'
import { MCP_OWNER_POLICY, type HttpOwnerRule } from '../../http-owner-policy'
import { isOwnerQuestion } from '../../owner-policy'
import { auditOwnerDenied, firstDeniedRef, httpAccessRequest } from '../owner-scope'

/**
 * The owner gate (T-18) for `/mcp` tools, applied at REGISTRATION like T-15's role
 * gate (`admin-gate.ts`): {@link withMcpOwnerGate} wraps the server every
 * `register*Tool` receives, so each tool's handler first checks every id its
 * arguments name against `MCP_OWNER_POLICY` through the one access function.
 *
 * The caller is the MCP SDK's `authInfo` (`clientId` = the verified principal's user
 * id, set by `/mcp` from the hub's bearer gate, `mcpAuthInfo`). A refused call is a
 * tool error `Not found` — someone else's, missing and ownerless read the same —
 * plus one `authz.denied` line. Every tool but an `open` one is an owner question,
 * `admin` ones included (T-106); an unmarked one is refused (fail closed). An
 * allowed call runs as its caller (the security context), so its refresh pings reach
 * the caller's streams only (T-17).
 *
 * Inert without login (the desktop app's hub): the handler runs as registered.
 *
 * @module transport/mcp-tools/owner-gate
 */

const refusal = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  isError: true
})

function callerOf(extra: unknown): string | null {
  const id = (extra as { authInfo?: AuthInfo } | undefined)?.authInfo?.clientId
  return typeof id === 'string' && id ? id : null
}

export function withMcpOwnerGate(
  server: McpServer,
  db: SlayzoneDb,
  policy: Readonly<Record<string, HttpOwnerRule>> = MCP_OWNER_POLICY,
  classes: Readonly<Record<string, AccessClass>> = MCP_ADMIN_POLICY
): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver)
      if ((prop !== 'tool' && prop !== 'registerTool') || typeof value !== 'function') return value
      return (name: string, ...rest: unknown[]) => {
        const handler = rest[rest.length - 1]
        if (typeof handler !== 'function') {
          throw new Error(`MCP tool ${name} has no handler to gate`)
        }
        const target_ = `mcp ${name}`
        // The SDK passes the parsed arguments first (when the tool has a schema) and
        // `extra` (with `authInfo`) last.
        const gated = async (...args: unknown[]) => {
          if (!getAuthGate() || !isOwnerQuestion(classes[name])) return handler(...args)
          const userId = callerOf(args[args.length - 1])
          const rule = policy[name]
          if (!rule) {
            auditOwnerDenied({ target: target_, reason: 'owner_unclassified', actor: userId })
            return refusal(`${name} has no owner rule (http-owner-policy.ts)`)
          }
          if (!userId) {
            auditOwnerDenied({ target: target_, reason: 'no_principal', actor: null })
            return refusal('Not found')
          }
          const input = args.length > 1 ? args[0] : {}
          const scope = createAccessScope(db, httpAccessRequest(userId))
          const denied = await firstDeniedRef(db, scope, rule.ids ?? [], input)
          if (denied) {
            auditOwnerDenied({ target: target_, reason: 'not_owner', actor: userId, denied })
            return refusal('Not found')
          }
          return runAsSecurityActor(userId, () => handler(...args))
        }
        return value.call(target, name, ...rest.slice(0, -1), gated)
      }
    }
  })
}
