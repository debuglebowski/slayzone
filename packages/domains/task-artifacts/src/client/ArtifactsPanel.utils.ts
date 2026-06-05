import { FileText, Code } from 'lucide-react'
import type { TaskArtifact } from '@slayzone/task/shared'
import { getEffectiveRenderMode } from '@slayzone/task/shared'
import { RENDER_MODE_ICONS } from './ArtifactsPanel.constants'

export function formatRelativeDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function getArtifactIcon(artifact: TaskArtifact): typeof FileText {
  const mode = getEffectiveRenderMode(artifact.title, artifact.render_mode)
  return RENDER_MODE_ICONS[mode] ?? Code
}
