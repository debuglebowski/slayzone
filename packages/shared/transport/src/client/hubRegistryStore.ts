import { create } from 'zustand'
import type { HubEntry } from '@slayzone/types'

/**
 * Live hub registry — the reactive counterpart to the one-shot boot read.
 * `main.tsx` seeds this once at boot with the exact same data that used to
 * flow directly into `<FederationProvider>` props; `FederatedRoot` subscribes
 * to it so a live hub add (see `HubsSettingsTab.save()`'s add-only path) can
 * update the running app without a relaunch. `addHubs` is append-only and
 * never touches the default hub's entry — it can't disturb the
 * `server.url`-pinning `main.tsx` applies to the default/local hub.
 */

type HubRegistryState = {
  hubs: HubEntry[]
  defaultHubId: string
  tokens: Record<string, string>
  seed: (hubs: HubEntry[], defaultHubId: string, tokens: Record<string, string>) => void
  addHubs: (entries: HubEntry[]) => void
  setTokens: (tokens: Record<string, string>) => void
}

export const useHubRegistryStore = create<HubRegistryState>((set) => ({
  hubs: [],
  defaultHubId: 'local',
  tokens: {},
  seed: (hubs, defaultHubId, tokens) => set({ hubs, defaultHubId, tokens }),
  addHubs: (entries) =>
    set((s) => ({
      hubs: [...s.hubs, ...entries.filter((e) => !s.hubs.some((h) => h.id === e.id))]
    })),
  setTokens: (tokens) => set({ tokens })
}))
