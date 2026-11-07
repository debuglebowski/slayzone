import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { HubIssue } from '@slayzone/transport/client'

/**
 * The hub-issue banners' choices (`HubIssueBanners`):
 *
 * - `muted`: hubs whose banner the user turned off ("Don't show again"). Kept per
 *   device in localStorage, not in a hub's settings: the banner exists for when a
 *   hub cannot be reached, and its own off switch must not depend on one. Turned
 *   back on from that hub's card in Settings → Hubs.
 * - `dismissed`: per hub, the cause the user closed. Not persisted: a closed banner
 *   returns when that hub's cause changes, or after a restart.
 * - `pendingSignIn`: the hub the banner's Sign in asked Settings → Hubs to start a
 *   sign-in for; that tab takes it once it is open.
 */
interface HubIssueBannerState {
  muted: string[]
  dismissed: Record<string, HubIssue['kind']>
  pendingSignIn: string | null
  setMuted: (hubId: string, muted: boolean) => void
  dismiss: (hubId: string, kind: HubIssue['kind']) => void
  /** Forget a closed banner: its hub's issue is gone, so the next one is new. */
  clearDismissal: (hubId: string) => void
  requestSignIn: (hubId: string) => void
  takeSignInRequest: () => string | null
}

export const HUB_ISSUE_BANNER_STORAGE_KEY = 'slayzone:hub-issue-banners'

export const useHubIssueBannerStore = create<HubIssueBannerState>()(
  persist(
    (set, get) => ({
      muted: [],
      dismissed: {},
      pendingSignIn: null,
      setMuted: (hubId, muted) =>
        set((s) => ({
          muted: muted
            ? s.muted.includes(hubId)
              ? s.muted
              : [...s.muted, hubId]
            : s.muted.filter((id) => id !== hubId)
        })),
      dismiss: (hubId, kind) => set((s) => ({ dismissed: { ...s.dismissed, [hubId]: kind } })),
      clearDismissal: (hubId) =>
        set((s) => {
          if (!(hubId in s.dismissed)) return s
          const { [hubId]: _gone, ...rest } = s.dismissed
          return { dismissed: rest }
        }),
      requestSignIn: (hubId) => set({ pendingSignIn: hubId }),
      takeSignInRequest: () => {
        const hubId = get().pendingSignIn
        if (hubId) set({ pendingSignIn: null })
        return hubId
      }
    }),
    {
      name: HUB_ISSUE_BANNER_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ muted: s.muted })
    }
  )
)
