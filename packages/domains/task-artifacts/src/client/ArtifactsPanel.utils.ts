import { FileText, Code } from 'lucide-react'
import type { TaskArtifact } from '@slayzone/task-contracts'
import { getEffectiveRenderMode } from '@slayzone/task-contracts'
import { RENDER_MODE_ICONS } from './ArtifactsPanel.constants'

export { formatRelativeDate } from '../shared/relative-date'

export function getArtifactIcon(artifact: TaskArtifact): typeof FileText {
  const mode = getEffectiveRenderMode(artifact.title, artifact.render_mode)
  return RENDER_MODE_ICONS[mode] ?? Code
}

/** A byte count for display: "512 B", "48 KB", "1.2 MB". */
export function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}
