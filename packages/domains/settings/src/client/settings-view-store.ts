import { create } from 'zustand'
import {
  DEFAULT_SETTINGS_ROUTE,
  routeFromLegacyTab,
  routeFromProjectTab,
  type SettingsRoute
} from './settings-route'

/**
 * Open state + route of the full-window Settings view. One store for both shells
 * (desktop App.tsx and the fork's HomeView), replacing the desktop's local
 * `settingsOpen` state and the fork's dialog-store flags.
 *
 * Other domains never import this: they keep dispatching the `open-settings` /
 * `open-project-settings` window events, which `installSettingsEventBridge` turns
 * into routes. A legacy tab key (`'worktrees'`) is accepted everywhere a route is.
 */
interface SettingsViewState {
  open: boolean
  route: SettingsRoute
  /** Bumped on every close: consumers that cache settings (appearance) re-read them. */
  revision: number
  navigate: (route: SettingsRoute) => void
}

export const useSettingsViewStore = create<SettingsViewState>((set) => ({
  open: false,
  route: DEFAULT_SETTINGS_ROUTE,
  revision: 0,
  navigate: (route) => set({ route })
}))

function toRoute(target: SettingsRoute | string | null | undefined): SettingsRoute {
  return typeof target === 'object' && target ? target : routeFromLegacyTab(target)
}

export function openSettings(target?: SettingsRoute | string | null): void {
  useSettingsViewStore.setState({ open: true, route: toRoute(target) })
}

export function openProjectSettings(
  projectId: string,
  tab?: string | null,
  onboarding?: 'github' | 'linear' | 'jira' | null
): void {
  const route = routeFromProjectTab(projectId, tab)
  openSettings(onboarding && route.kind === 'project' ? { ...route, onboarding } : route)
}

export function closeSettings(): void {
  if (!useSettingsViewStore.getState().open) return
  useSettingsViewStore.setState((s) => ({ open: false, revision: s.revision + 1 }))
}

/**
 * `open-settings` (detail: route or legacy tab key) and, with `projects`,
 * `open-project-settings` (detail: `{ projectId, tab? }`) → the store. Installed once
 * by each shell. `projects` stays off while a shell still opens its own project
 * settings dialog, so one event never opens both.
 */
export function installSettingsEventBridge({ projects = false } = {}): () => void {
  const onOpen = (e: Event) => openSettings((e as CustomEvent).detail)
  const onOpenProject = (e: Event) => {
    const detail = (e as CustomEvent<{ projectId?: string; tab?: string } | null>).detail
    if (detail?.projectId) openProjectSettings(detail.projectId, detail.tab)
  }
  window.addEventListener('open-settings', onOpen)
  if (projects) window.addEventListener('open-project-settings', onOpenProject)
  return () => {
    window.removeEventListener('open-settings', onOpen)
    window.removeEventListener('open-project-settings', onOpenProject)
  }
}
