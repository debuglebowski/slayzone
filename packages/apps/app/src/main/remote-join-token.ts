/**
 * Mint a join token for THIS machine's computer on a remote hub, with the user's
 * session there — what lets the app's own computer join every hub the client lists
 * (`local-computer-hubs.ts`).
 *
 * `POST /api/computers/join-token` with the hub bearer. Every signed-in user may mint
 * for their own computer (the hub's `join-token-policy.ts`); naming nobody makes the
 * caller its owner. Over `nodeHubTransport`, like every other main → remote-hub call
 * (`boot-config.ts`): Node's `fetch` sends Fetch Metadata the hub reads as a browser.
 *
 * @module app/main/remote-join-token
 */
import { nodeHubTransport } from '@slayzone/hub-auth/client-node'
import type { HubTransport } from '@slayzone/hub-auth/client'
import { toHubOrigin } from './boot-config'
import type { MintedJoinToken } from './local-computer-hubs'

const MINT_TIMEOUT_MS = 15_000

export async function mintRemoteJoinToken(
  hubClientUrl: string,
  bearer: string | null,
  label: string,
  transport: HubTransport = nodeHubTransport
): Promise<MintedJoinToken> {
  if (!bearer) throw new Error('sign in to this hub to let this computer join it')
  const res = await transport({
    url: `${toHubOrigin(hubClientUrl)}/api/computers/join-token`,
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
    timeoutMs: MINT_TIMEOUT_MS,
    maxResponseChars: 64_000
  })
  let body: { token?: unknown; hubUrl?: unknown; error?: unknown } = {}
  try {
    body = JSON.parse(res.text) as typeof body
  } catch {
    /* not JSON — the status says enough */
  }
  if (res.status === 401) throw new Error('your session on this hub expired; sign in again')
  if (res.status !== 200 || typeof body.token !== 'string' || typeof body.hubUrl !== 'string') {
    const why = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
    throw new Error(`the hub refused a join token: ${why}`)
  }
  return { token: body.token, hubUrl: body.hubUrl }
}
