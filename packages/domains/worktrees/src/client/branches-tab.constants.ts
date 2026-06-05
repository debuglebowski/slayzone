import type { CommitGraphConfig } from '../shared/types'

export const FETCH_LIMIT = 2000 // fetch more for accurate branch topology
export const RENDER_LIMIT = 500 // cap DOM nodes for performance

export const DEFAULT_CONFIG: CommitGraphConfig = {
  baseBranch: '', // resolved at runtime
  collapsed: false,
  showBranches: true,
  breakOnTags: true,
  breakOnMerges: true
}
