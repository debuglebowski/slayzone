import { electronBootstrap } from '@slayzone/transport/client'
import {
  canExportAsHtml,
  canExportAsPdf,
  canExportAsPng,
  getEffectiveRenderMode,
  type RenderMode
} from '@slayzone/task-contracts'

export type ArtifactExportFormat = 'pdf' | 'png' | 'html'

const CAN_EXPORT: Record<ArtifactExportFormat, (mode: RenderMode) => boolean> = {
  pdf: canExportAsPdf,
  png: canExportAsPng,
  html: canExportAsHtml
}

/**
 * Export an artifact on the device the person is using: the host app (desktop's
 * Electron, the web shell's browser) renders `content` and saves the file there. The
 * hub only supplied the content, so this works the same against a local or a remote hub.
 *
 * `true` = saved; `false` = nothing to do (mode has no such export) or the person
 * dismissed the save dialog. Throws on a real failure, for the caller's toast.
 */
export async function exportArtifactOnThisDevice(
  artifact: { title: string; render_mode: RenderMode | null },
  content: string,
  format: ArtifactExportFormat
): Promise<boolean> {
  const mode = getEffectiveRenderMode(artifact.title, artifact.render_mode)
  if (!CAN_EXPORT[format](mode)) return false
  const result = await electronBootstrap.exportArtifact({
    format,
    content,
    mode,
    title: artifact.title
  })
  if (result.ok) return true
  if ('canceled' in result) return false
  throw new Error(result.error)
}
