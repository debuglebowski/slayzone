import type { IncomingMessage, ServerResponse } from 'node:http'
import { bindRestComputer, type RestPrincipal } from '@slayzone/api'
import { createHttpTunnelServer } from '@slayzone/computer-transport/server'
import { authorizeDelegatedHuman, findHubAccount, type HubAuth } from '@slayzone/hub-auth/server'

interface ComputerOwner {
  owner_user_id: string | null
  revoked_at: string | null
}
interface Account {
  userId: string
  role: RestPrincipal['role']
  disabled: boolean
}

/**
 * The account a relayed request acts for: the computer's owner, through the IdP-role
 * gate (hub-auth `authorizeDelegatedHuman`) — the computer's own credential is
 * automation and stays valid, but a human whose role evidence is stale, missing or
 * denied, or a process whose view of the mode is not the persisted one, lends it
 * nothing. Null = refused.
 */
export async function relayOwnerAccount(auth: HubAuth, userId: string): Promise<Account | null> {
  const account = await findHubAccount(auth, userId)
  if (!account || account.disabled) return account
  const verdict = await authorizeDelegatedHuman(auth, userId)
  if (!verdict.ok) return null
  return { ...account, role: verdict.role ?? account.role }
}

/** The relay's only identity authority is the computer gateway. The HTTP parser
 * is private and the principal map is keyed on its actual request objects. */
export function createHubCliRelay(deps: {
  computer(id: string): Promise<ComputerOwner | null>
  account(id: string): Promise<Account | null>
  dispatch(req: IncomingMessage, res: ServerResponse): void
}) {
  const principals = new WeakMap<IncomingMessage, Promise<RestPrincipal | null>>()
  const relay = createHttpTunnelServer((computerId, req, res) => {
    const raw = req.url ?? ''
    const allowed =
      /^\/api\/(?:tasks|projects|tags|templates|automations|artifacts|artifact-folders|pty|tabs|panels|processes|notify|open-task|close-task|open-artifact|browser|chat|agent)(?:[/?]|$)/.test(
        raw
      ) ||
      (req.method === 'GET' && raw.split('?')[0] === '/api/computers')
    if (!allowed) {
      res.writeHead(403, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          error:
            'This endpoint is not available through the task CLI relay. Use an explicit hub login for administration.'
        })
      )
      return
    }
    bindRestComputer(req, computerId)
    principals.set(
      req,
      (async () => {
        const computer = await deps.computer(computerId)
        if (!computer || computer.revoked_at) throw new Error('computer revoked')
        if (!computer.owner_user_id) return null
        const account = await deps.account(computer.owner_user_id)
        if (!account || account.disabled) throw new Error('owner disabled')
        return { userId: account.userId, role: account.role, scopes: ['full'] } as RestPrincipal
      })()
    )
    deps.dispatch(req, res)
  })
  return {
    ...relay,
    principalOf: (req: IncomingMessage) => principals.get(req)
  }
}
