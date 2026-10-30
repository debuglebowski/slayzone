import { FileText, Code } from 'lucide-react'
import type { TaskArtifact } from '@slayzone/task-contracts'
import { getEffectiveRenderMode } from '@slayzone/task-contracts'
import { RENDER_MODE_ICONS } from './ArtifactsPanel.constants'

export { formatRelativeDate } from '../shared/relative-date'

export function getArtifactIcon(artifact: TaskArtifact): typeof FileText {
  const mode = getEffectiveRenderMode(artifact.title, artifact.render_mode)
  return RENDER_MODE_ICONS[mode] ?? Code
}
