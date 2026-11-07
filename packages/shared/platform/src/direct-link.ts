/**
 * Direct client ↔ computer link facts shared by the desktop's main process and its
 * clients (docs/direct-link.md).
 *
 * @module platform/direct-link
 */
import { isLoopbackAuthority } from './hub-addr'

/**
 * The hub id a direct link names outside any hub scope (a single-hub client): the
 * desktop's main process reads it as the registry's default hub.
 */
export const DIRECT_LINK_DEFAULT_HUB_ID = 'default'

/**
 * A direct-link listener address in its one canonical spelling: a bare authority
 * with the host lower-cased and its scheme's default port dropped (the scheme rule:
 * loopback → `ws`, so `:80`; any other host → `wss`, so `:443`). The hub issues
 * this spelling and the desktop's gate and CSP compare it, so `box:443` and `box`
 * are one address. Null when `address` is not a bare `host[:port]` authority.
 */
export function normalizeDirectAddress(address: string): string | null {
  if (typeof address !== 'string' || address === '' || /[\s/\\*@?#]/.test(address)) return null
  if (address.includes('://')) return null
  let url: URL
  try {
    url = new URL(`${isLoopbackAuthority(address) ? 'ws' : 'wss'}://${address}`)
  } catch {
    return null
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '')
    return null
  return url.host
}
