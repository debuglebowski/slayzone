import type { CommitGraphConfig, ResolvedGraph } from '../shared/types'

/**
 * Persistence seam for a graph instance's display config. The task variant
 * routes to the `tasks.commit_graph_config` column; the project variant routes
 * to the `commit_graph:project:<id>` settings key. `key` is a stable identity
 * for effect deps (changes only when the underlying task/project changes).
 */
export interface CommitGraphPersistence {
  key: string
  load: () => Promise<Partial<CommitGraphConfig> | null>
  /** Persist the config (already stripped of the runtime-only `baseBranch`). */
  save: (config: Omit<CommitGraphConfig, 'baseBranch'>) => void
  clear: () => Promise<void>
}

export interface BranchGraphState {
  dagGraph: ResolvedGraph | null
  loading: boolean
  filter: string
  setFilter: (v: string) => void
  config: CommitGraphConfig
  setConfig: React.Dispatch<React.SetStateAction<CommitGraphConfig>>
  resetConfig: () => void
  effectiveBaseBranch: string
  fetching: boolean
  handleFetch: () => Promise<void>
  refresh: () => Promise<void>
}
