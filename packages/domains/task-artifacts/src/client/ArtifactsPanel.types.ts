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
  /** Share one file with people (T-100). Absent: no Share entry (a hub without login). */
  onShareArtifact?: (artifact: { id: string; title: string }) => void
  /** A View member's panel (T-100): files open and download, nothing changes them. */
  readOnly?: boolean
  /**
   * Show this one artifact only (a task's Artifact panel): no sidebar and no
   * selection of its own — the panel is about this file. Read at mount.
   */
  pinnedArtifactId?: string
  /** "Open in its own panel" on a file (the task opens an Artifact panel). Absent: no entry. */
  onOpenInOwnPanel?: (artifact: { id: string; title: string }) => void
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
