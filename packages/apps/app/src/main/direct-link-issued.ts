/**
 * Ask a hub which computer addresses it issued direct links to for this client
 * (`GET /api/computers/direct-addresses`, the caller's live grants) — the only
 * addresses `direct-link-gate.ts` lets the renderer's CSP name (docs/direct-link.md).
 *
 * Fails closed: anything but a well-formed answer names nothing. Over
 * `nodeHubTransport`, like every other main → hub call (`remote-join-token.ts`).
 *
 * @module app/main/direct-link-issued
 */
import { nodeHubTransport } from '@slayzone/hub-auth/client-node'
import type { HubTransport } from '@slayzone/hub-auth/client'

const TIMEOUT_MS = 5_000

export async function fetchIssuedDirectAddresses(
  hubOrigin: string,
  bearer: string | null,
  transport: HubTransport = nodeHubTransport
): Promise<string[]> {
  const res = await transport({
    url: `${hubOrigin}/api/computers/direct-addresses`,
    method: 'GET',
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    timeoutMs: TIMEOUT_MS,
    maxResponseChars: 64_000
  }).catch(() => null)
  if (!res || res.status !== 200) return []
  let body: { addresses?: unknown }
  try {
    body = JSON.parse(res.text) as typeof body
  } catch {
    return []
  }
  if (!Array.isArray(body.addresses)) return []
  return body.addresses.filter((a): a is string => typeof a === 'string' && a !== '')
}
