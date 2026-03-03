/// <reference types="vite/client" />

import type { ElectronAPI } from '@slayzone/types'

interface ImportMetaEnv {
  readonly VITE_CONVEX_URL?: string
  readonly VITE_COMMUNITY_DISCORD_URL?: string
  readonly VITE_UPDATES_X_URL?: string
}

declare global {
  interface Window {
    api: ElectronAPI
  }
}
