import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { shallow } from 'zustand/shallow'
import type { ConfigLevel } from '../shared'

export type SkillGroupBy = 'none' | 'source' | 'prefix'

interface ContextManagerViewState {
  // Navigation
  activeLevel: ConfigLevel
  activeSection: string

  // Skills
  skillViewMode: Record<string, 'list' | 'graph'>

  // Computer files
  computerSelectedPath: string | null
  computerSplitWidth: number

  // Project context tree
  projectSelectedPath: string | null
  projectExpandedFolders: string[]
  projectSplitWidth: number

  // Skill editor panel (null = 50% of available)
  skillEditorWidth: number | null

  // File tree display toggles
  showBlobs: boolean
  showLineCount: boolean

  // Skill list grouping
  skillGroupBy: SkillGroupBy

  // Marketplace navigation
  marketplaceDrillRegistryId: string | null
  marketplaceDrillEntryId: string | null

  // Library skill navigation (one-shot, consumed by SkillsSection on mount)
  pendingLibrarySkillId: string | null

  // Hydration
  isLoaded: boolean

  // Actions
  setActive: (level: ConfigLevel, section: string) => void
  navigateToMarketplaceRegistry: (registryId: string) => void
  navigateToMarketplaceEntry: (registryId: string, entryId: string) => void
  navigateToLibrarySkill: (itemId: string) => void
  consumePendingLibrarySkillId: () => string | null
  setSkillViewMode: (scope: string, mode: 'list' | 'graph') => void
  setComputerSelectedPath: (path: string | null) => void
  setComputerSplitWidth: (width: number) => void
  setProjectSelectedPath: (path: string | null) => void
  setProjectExpandedFolders: (folders: string[]) => void
  setProjectSplitWidth: (width: number) => void
  setSkillEditorWidth: (width: number | null) => void
  setShowBlobs: (show: boolean) => void
  setShowLineCount: (show: boolean) => void
  setSkillGroupBy: (v: SkillGroupBy) => void
  _loadState: (persisted: Partial<PersistedState>) => void
}

/** Only these fields are persisted to the database */
interface PersistedState {
  activeLevel: ConfigLevel
  activeSection: string
  skillViewMode: Record<string, 'list' | 'graph'>
  computerSelectedPath: string | null
  computerSplitWidth: number
  projectSelectedPath: string | null
  projectExpandedFolders: string[]
  projectSplitWidth: number
  skillEditorWidth: number | null
  showBlobs: boolean
  showLineCount: boolean
  skillGroupBy: SkillGroupBy
}

const DEFAULTS: PersistedState = {
  activeLevel: 'computer',
  activeSection: 'files',
  skillViewMode: {},
  computerSelectedPath: null,
  computerSplitWidth: 350,
  projectSelectedPath: null,
  projectExpandedFolders: [],
  projectSplitWidth: 350,
  skillEditorWidth: null,
  showBlobs: true,
  showLineCount: true,
  skillGroupBy: 'source',
}

export const useContextManagerStore = create<ContextManagerViewState>()(
  subscribeWithSelector((set, get) => ({
    ...DEFAULTS,
    marketplaceDrillRegistryId: null,
    marketplaceDrillEntryId: null,
    pendingLibrarySkillId: null,
    isLoaded: false,

    setActive: (level, section) => set({ activeLevel: level, activeSection: section }),
    navigateToMarketplaceRegistry: (registryId) =>
      set({ activeLevel: 'library' as ConfigLevel, activeSection: 'marketplace', marketplaceDrillRegistryId: registryId, marketplaceDrillEntryId: null }),
    navigateToMarketplaceEntry: (registryId, entryId) =>
      set({ activeLevel: 'library' as ConfigLevel, activeSection: 'marketplace', marketplaceDrillRegistryId: registryId, marketplaceDrillEntryId: entryId }),
    navigateToLibrarySkill: (itemId) =>
      set({ activeLevel: 'library' as ConfigLevel, activeSection: 'skills', pendingLibrarySkillId: itemId }),
    consumePendingLibrarySkillId: () => {
      const id = get().pendingLibrarySkillId
      if (id) set({ pendingLibrarySkillId: null })
      return id
    },
    setSkillViewMode: (scope, mode) =>
      set((s) => ({ skillViewMode: { ...s.skillViewMode, [scope]: mode } })),
    setComputerSelectedPath: (path) => set({ computerSelectedPath: path }),
    setComputerSplitWidth: (width) => set({ computerSplitWidth: width }),
    setProjectSelectedPath: (path) => set({ projectSelectedPath: path }),
    setProjectExpandedFolders: (folders) => set({ projectExpandedFolders: folders }),
    setProjectSplitWidth: (width) => set({ projectSplitWidth: width }),
    setSkillEditorWidth: (width) => set({ skillEditorWidth: width }),
    setShowBlobs: (show) => set({ showBlobs: show }),
    setShowLineCount: (show) => set({ showLineCount: show }),
    setSkillGroupBy: (v) => set({ skillGroupBy: v }),

    _loadState: (persisted) => {
      const validGroupBy: SkillGroupBy[] = ['none', 'source', 'prefix']
      const { skillGroupBy: rawGroupBy, ...rest } = persisted
      const groupBy = validGroupBy.includes(rawGroupBy as SkillGroupBy)
        ? (rawGroupBy as SkillGroupBy)
        : (DEFAULTS.skillGroupBy as SkillGroupBy)
      set({ ...DEFAULTS, ...rest, skillGroupBy: groupBy, isLoaded: true })
    },
  }))
)

// --- Eager hydration at module scope (same pattern as useTabStore) ---

const DB_KEY = 'context_manager_view_state'

export const contextManagerStoreReady: Promise<void> =
  typeof window !== 'undefined' && window.api?.settings
    ? window.api.settings
        .get(DB_KEY)
        .then((value) => {
          if (value) {
            try {
              useContextManagerStore.getState()._loadState(JSON.parse(value))
            } catch {
              useContextManagerStore.setState({ isLoaded: true })
            }
          } else {
            useContextManagerStore.setState({ isLoaded: true })
          }
        })
        .catch(() => {
          useContextManagerStore.setState({ isLoaded: true })
        })
    : Promise.resolve()

// --- Debounced persistence ---

let _debounceTimer: ReturnType<typeof setTimeout> | null = null

function pickPersisted(state: ContextManagerViewState): PersistedState {
  return {
    activeLevel: state.activeLevel,
    activeSection: state.activeSection,
    skillViewMode: state.skillViewMode,
    computerSelectedPath: state.computerSelectedPath,
    computerSplitWidth: state.computerSplitWidth,
    projectSelectedPath: state.projectSelectedPath,
    projectExpandedFolders: state.projectExpandedFolders,
    projectSplitWidth: state.projectSplitWidth,
    skillEditorWidth: state.skillEditorWidth,
    showBlobs: state.showBlobs,
    showLineCount: state.showLineCount,
    skillGroupBy: state.skillGroupBy,
  }
}

useContextManagerStore.subscribe(
  pickPersisted,
  (slice) => {
    if (!useContextManagerStore.getState().isLoaded) return
    if (_debounceTimer) clearTimeout(_debounceTimer)
    _debounceTimer = setTimeout(() => {
      window.api.settings.set(DB_KEY, JSON.stringify(slice))
    }, 500)
  },
  { equalityFn: shallow }
)
