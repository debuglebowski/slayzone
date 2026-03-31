import type { Terminal as XTerm, ITheme } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SerializeAddon } from '@xterm/addon-serialize'
import type { SearchAddon } from '@xterm/addon-search'
import type { TerminalMode } from '@slayzone/terminal/shared'

export interface CachedTerminal {
  terminal: XTerm
  fitAddon: FitAddon
  serializeAddon: SerializeAddon
  searchAddon: SearchAddon
  element: HTMLElement
  serializedState?: string
  mode?: TerminalMode
  lastRenderedSeq?: number
}

// Module-level cache for terminal instances (unmounted terminals)
const cache = new Map<string, CachedTerminal>()

// Active (mounted) terminal serialize addons — terminals in the DOM aren't in the cache
const activeAddons = new Map<string, SerializeAddon>()

// Track sessionIds that shouldn't be re-cached (e.g., during restart/mode-change)
const skipCacheSet = new Set<string>()
// Track pending timeouts for skipCache cleanup
const skipCacheTimeouts = new Map<string, NodeJS.Timeout>()

export function getTerminal(sessionId: string): CachedTerminal | undefined {
  return cache.get(sessionId)
}

export function setTerminal(sessionId: string, instance: CachedTerminal): void {
  // Don't cache if marked for skip (e.g., during restart/mode-change)
  if (skipCacheSet.has(sessionId)) {
    skipCacheSet.delete(sessionId)
    // Also clear any existing cache entry (from before restart was triggered)
    cache.delete(sessionId)
    instance.terminal.dispose()
    return
  }
  cache.set(sessionId, instance)
}

export function removeTerminal(sessionId: string): boolean {
  const instance = cache.get(sessionId)
  if (instance) {
    instance.terminal.dispose()
    cache.delete(sessionId)
    return true
  }
  return false
}

// Dispose terminal without needing the instance (for idle hibernation)
export function disposeTerminal(sessionId: string): boolean {
  // Clear skip flag if set (handles idle-before-restart race condition)
  skipCacheSet.delete(sessionId)

  const instance = cache.get(sessionId)
  if (instance) {
    instance.terminal.dispose()
    cache.delete(sessionId)
    return true
  }
  return false
}

export function hasTerminal(sessionId: string): boolean {
  return cache.has(sessionId)
}

// Mark sessionId to skip caching on next setTerminal call (for restart/mode-change)
export function markSkipCache(sessionId: string): void {
  // Clear any existing timeout for this sessionId
  const existingTimeout = skipCacheTimeouts.get(sessionId)
  if (existingTimeout) {
    clearTimeout(existingTimeout)
  }

  skipCacheSet.add(sessionId)
  // Auto-clear after 2 seconds as safety net against stale entries
  const timeout = setTimeout(() => {
    skipCacheSet.delete(sessionId)
    skipCacheTimeouts.delete(sessionId)
  }, 2000)
  skipCacheTimeouts.set(sessionId, timeout)
}

export function updateAllThemes(theme: ITheme, minimumContrastRatio?: number): void {
  for (const entry of cache.values()) {
    entry.terminal.options.theme = theme
    if (minimumContrastRatio !== undefined) {
      entry.terminal.options.minimumContrastRatio = minimumContrastRatio
    }
  }
}

export function getCacheSize(): number {
  return cache.size
}

export function registerActiveAddon(sessionId: string, addon: SerializeAddon): void {
  activeAddons.set(sessionId, addon)
}

export function unregisterActiveAddon(sessionId: string): void {
  activeAddons.delete(sessionId)
}

export function serializeTerminalHistory(sessionId: string): string {
  const addon = activeAddons.get(sessionId) ?? cache.get(sessionId)?.serializeAddon
  if (!addon) return ''
  try { return addon.serialize() }
  catch { return '' }
}
