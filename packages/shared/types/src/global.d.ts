import type { ElectronAPI } from './api'

declare global {
  interface ImportMetaEnv {
    readonly DEV: boolean
    readonly PROD: boolean
    readonly MODE: string
    [key: string]: unknown
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv
  }
  interface Window {
    api: ElectronAPI
  }
}

export {}
