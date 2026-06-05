import type { ArtifactVersion, DiffResult } from '@slayzone/task-artifacts/shared'

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
