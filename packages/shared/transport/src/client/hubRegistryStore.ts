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
