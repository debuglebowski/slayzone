import type { ArtifactVersion, DiffResult } from '@slayzone/task-artifacts/shared'
import type { ArtifactsSidebarState } from '@slayzone/task-contracts'

export interface ArtifactsPanelHandle {
  selectArtifact: (id: string) => void
  createArtifact: () => void
  toggleSearch: () => void
}

export interface ArtifactsPanelProps {
  taskId: string
  isResizing?: boolean
  initialActiveArtifactId?: string | null
  onActiveArtifactIdChange?: (id: string | null) => void
  /** The task's saved sidebar visibility + width (null = defaults). Read at mount. */
  initialSidebarState?: ArtifactsSidebarState | null
  /** A user change to the sidebar (toggle, resize end, reset) — the parent saves it. */
  onSidebarStateChange?: (state: Required<ArtifactsSidebarState>) => void
  /** Open a URL in the task's in-app browser (⌘-clicked links). */
  onOpenUrl?: (url: string) => void
}

export type ArtifactViewMode = 'preview' | 'split' | 'raw'

export interface ViewingVersion {
  version: ArtifactVersion
  content: string
  diff: DiffResult | null
  mode: 'diff' | 'content'
  /** version_num to diff against. undefined = default (latest per IPC). */
  diffAgainst: number | undefined
}
