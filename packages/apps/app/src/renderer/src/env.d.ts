/// <reference types="vite/client" />

import type { ElectronAPI } from '@slayzone/types'

interface ImportMetaEnv {
  readonly VITE_CONVEX_URL?: string
}

declare global {
  interface Window {
    /**
     * Intentional bootstrap-only preload surface. Domain calls use tRPC.
     */
    api: ElectronAPI
    __testInvoke?: (channel: string, ...args: unknown[]) => Promise<unknown>
    __testEmit?: (channel: string, data: unknown) => void
  }
}
