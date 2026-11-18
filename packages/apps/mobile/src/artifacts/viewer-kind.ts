/**
 * Which viewer an artifact gets: desktop's render mode (`getEffectiveRenderMode` — the
 * artifact's own `render_mode` if set, else its title's extension, else markdown), one
 * viewer per mode.
 */
import {
  getEffectiveRenderMode,
  getExtensionFromTitle,
  type RenderMode,
  type TaskArtifact
} from '@slayzone/task-contracts/types'

export type ViewerKind =
  | 'markdown'
  | 'code'
  | 'html'
  | 'svg'
  | 'mermaid'
  | 'image'
  | 'pdf'
  | 'video'
  | 'audio'
  | 'archive'
  | 'font'

const KIND_OF_MODE: Record<RenderMode, ViewerKind> = {
  markdown: 'markdown',
  code: 'code',
  'html-preview': 'html',
  'svg-preview': 'svg',
  'mermaid-preview': 'mermaid',
  image: 'image',
  pdf: 'pdf',
  video: 'video',
  audio: 'audio',
  // A patch reads as its source here, as it did before desktop gave it a diff view.
  diff: 'code',
  archive: 'archive',
  font: 'font'
}

export function viewerKindOf(artifact: Pick<TaskArtifact, 'title' | 'render_mode'>): ViewerKind {
  return KIND_OF_MODE[getEffectiveRenderMode(artifact.title, artifact.render_mode)]
}

/** Kinds shown from the downloaded file; the others from the artifact's text. */
export const isFileKind = (kind: ViewerKind): kind is 'image' | 'pdf' =>
  kind === 'image' || kind === 'pdf'

/** Kinds played by the native player (`media-player.ts`), from the downloaded file. */
export const isMediaKind = (kind: ViewerKind): kind is 'video' | 'audio' =>
  kind === 'video' || kind === 'audio'

/**
 * Containers iOS's player (AVPlayer) can't open, though desktop's Chromium plays them:
 * WebM, Ogg (Vorbis, Opus, Theora), Matroska. Never handed to the player: it would show
 * a black box.
 */
const UNPLAYABLE_ON_DEVICE = new Set(['.webm', '.weba', '.ogg', '.oga', '.ogv', '.opus', '.mkv'])

/** Whether a video or audio artifact can play on the device, by its title's extension. */
export function isPlayableOnDevice(title: string): boolean {
  return !UNPLAYABLE_ON_DEVICE.has(getExtensionFromTitle(title).toLowerCase())
}

/**
 * Kinds the phone has no viewer for yet: a note and Share. Nothing is fetched up
 * front; only Share needs the file.
 */
export const isShareOnlyKind = (kind: ViewerKind): kind is 'archive' | 'font' =>
  kind === 'archive' || kind === 'font'

/**
 * Text that was not text: a binary file in a text kind (desktop's fallback for an unknown
 * extension is markdown, so a `.zip` arrives here as UTF-8 noise). A NUL, or mostly
 * replacement characters (`readContent` decodes invalid bytes to U+FFFD).
 */
export function looksBinary(text: string): boolean {
  if (!text) return false
  if (text.includes('\u0000')) return true
  const sample = text.slice(0, 4096)
  let replaced = 0
  for (const ch of sample) if (ch === '�') replaced++
  return replaced / sample.length > 0.1
}

/** The title's extension as a badge: `MD`; '' when there is none. */
export function extensionBadge(title: string): string {
  return getExtensionFromTitle(title).slice(1).toUpperCase()
}
