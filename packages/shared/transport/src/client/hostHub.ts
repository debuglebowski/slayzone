import type { HubEntry } from '@slayzone/platform/hub-registry'

/**
 * The co-located local hub — the only hub with a capability bridge to this
 * desktop's Electron host — or null when none is listed (mobile, legacy remote
 * mode). Desktop-host procedures from any other hub are forwarded to it
 * (`hostRouteLink`).
 */
export function localHubIdOf(hubs: readonly HubEntry[]): string | null {
  return hubs.find((h) => h.kind === 'local')?.id ?? null
}
