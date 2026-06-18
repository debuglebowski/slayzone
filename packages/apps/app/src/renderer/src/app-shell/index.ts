// Barrel for App.tsx's extracted shell: lazy components, constants/types, hooks, and panels.
export * from './lazy'
export * from './constants'
export { useLazyMounted } from './useLazyMounted'
export { AppHeaderActions } from './AppHeaderActions'
export { CompactFooter } from './CompactFooter'
// HomeDetail now lives in the shared @slayzone/home package (one Home shell for
// the Electron app + the Chromium fork — no drift). App.tsx feeds it the same
// props as before; the fork uses HomeContainer (self-wiring) over the same component.
export { HomeDetail } from '@slayzone/home/client'
export { AppSidePanels } from './AppSidePanels'
export { AppDialogs } from './AppDialogs'
export { useExplodeMode } from './useExplodeMode'
export { useProjectPathGuard } from './useProjectPathGuard'
export { useAppUpdates } from './useAppUpdates'
export { useAuthFailureBanner } from './useAuthFailureBanner'
export { useAppShortcuts } from './useAppShortcuts'
export { useAppIpcListeners } from './useAppIpcListeners'
export { useIdlePreload } from './useIdlePreload'
