import { create } from 'zustand'
import type { HubEntry } from '@slayzone/platform/hub-registry'

/**
 * Live hub registry — the reactive counterpart to the one-shot boot read.
 * `main.tsx` seeds this once per document load with the exact same data that
 * used to flow directly into `<FederationProvider>` props; `FederatedRoot`
 * subscribes to it so a sign-in (`setTokens`) reaches the running app without
 * a relaunch. Adding a hub reloads the window instead of pushing into this
 * store: the renderer CSP is fixed per document load, so only a fresh load
 * admits the new hub's origin (#161).
 */

type HubRegistryState = {
  hubs: HubEntry[]
  defaultHubId: string
  tokens: Record<string, string>
  seed: (hubs: HubEntry[], defaultHubId: string, tokens: Record<string, string>) => void
  setTokens: (tokens: Record<string, string>) => void
}

export const useHubRegistryStore = create<HubRegistryState>((set) => ({
  hubs: [],
  defaultHubId: 'local',
  tokens: {},
  seed: (hubs, defaultHubId, tokens) => set({ hubs, defaultHubId, tokens }),
  setTokens: (tokens) => set({ tokens })
}))

/**
 * Seed this window's registry from the host's hub registry — EVERY window does this at
 * boot (main window and task windows), so "is this hub this device's own?" is answered
 * the same everywhere. The DEFAULT hub is pinned to the url the window dials
 * (`server.url`), so its client is the window's boot connection.
 */
export async function seedHubRegistry(
  server: { url: string },
  bootstrap: {
    getHubRegistry: () => Promise<{ hubs: HubEntry[]; defaultHubId: string }>
    getHubTokens: () => Promise<Record<string, string>>
  }
): Promise<{ hubs: HubEntry[]; defaultHubId: string; tokens: Record<string, string> }> {
  const [registry, tokens] = await Promise.all([
    bootstrap.getHubRegistry(),
    bootstrap.getHubTokens()
  ])
  const hubs = registry.hubs.map((h) =>
    h.id === registry.defaultHubId ? { ...h, url: server.url } : h
  )
  useHubRegistryStore.getState().seed(hubs, registry.defaultHubId, tokens)
  return { hubs, defaultHubId: registry.defaultHubId, tokens }
}
