import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { ADMIN_ONLY, MCP_ADMIN_POLICY, roleAllows, type AccessClass } from '../../admin-policy'
import { auditAdminDenied } from '../../admin-gate'
import type { RestPrincipal } from '../rest-api/types'

/**
 * The account-role gate (T-15) for `/mcp` tools, applied at REGISTRATION like the
 * REST one: {@link withMcpAdminGate} wraps the server every `register*Tool` receives,
 * so each tool's handler first checks the caller against `MCP_ADMIN_POLICY`.
 *
 * The caller arrives as the MCP SDK's `authInfo`, which the SDK builds from
 * `req.auth` on the HTTP request carrying the call: `/mcp` sets it from the principal
 * the hub's bearer gate verified ({@link mcpAuthInfo}). No `authInfo` = nothing to
 * check (a hub without login).
 *
 * @module transport/mcp-tools/admin-gate
 */

/** `req.auth` for an MCP request, from the verified REST principal. The bearer is
 *  not passed on: the hub gate already checked it. */
export function mcpAuthInfo(principal: RestPrincipal): AuthInfo {
  return {
    token: '',
    clientId: principal.userId,
    scopes: [...principal.scopes],
    extra: { role: principal.role }
  }
}

function roleOf(extra: unknown): 'admin' | 'user' | null {
  const role = (extra as { authInfo?: AuthInfo } | undefined)?.authInfo?.extra?.role
  return role === 'admin' || role === 'user' ? role : null
}

/**
 * The server every tool is registered on, with each handler behind the role check.
 * A refused call is a tool error whose text starts with `ADMIN_ONLY`, plus one
 * `authz.denied` line. An unclassified tool needs an admin (fail closed).
 */
export function withMcpAdminGate(
  server: McpServer,
  policy: Readonly<Record<string, AccessClass>> = MCP_ADMIN_POLICY
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
        // The SDK passes `extra` (with `authInfo`) as the handler's LAST argument,
        // with or without an argument schema.
        const gated = (...args: unknown[]) => {
          const role = roleOf(args[args.length - 1])
          if (role && !roleAllows(policy[name], role)) {
            auditAdminDenied({ targetKind: 'procedure', targetId: `mcp ${name}` })
            return {
              content: [
                { type: 'text' as const, text: `${ADMIN_ONLY}: ${name} needs a hub admin account` }
              ],
              isError: true
            }
          }
          return handler(...args)
        }
        return value.call(target, name, ...rest.slice(0, -1), gated)
      }
    }
  })
}
