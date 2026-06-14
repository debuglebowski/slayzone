import { ElectronAPI as ElectronToolkitAPI } from '@electron-toolkit/preload'
import type { ElectronAPI } from '@slayzone/types'

declare global {
  interface Window {
    electron: ElectronToolkitAPI
    /**
     * Intentional bootstrap-only preload surface. Do not extend for domain
     * features; use tRPC over WebSocket after renderer boot.
     */
    api: ElectronAPI
    /** Playwright-only bridge for test reset/env/native browser hooks. */
    __testInvoke?: (channel: string, ...args: unknown[]) => Promise<unknown>
    /** Playwright-only DOM event helper. */
    __testEmit?: (channel: string, data: unknown) => void
  }
}
