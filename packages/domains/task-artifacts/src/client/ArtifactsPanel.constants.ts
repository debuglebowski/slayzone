import {
  FileArchive,
  FileDiff,
  FileText,
  Code,
  Film,
  Globe,
  Image,
  GitBranch,
  Monitor,
  Moon,
  Music,
  Sun,
  Type
} from 'lucide-react'
import type { RenderMode } from '@slayzone/task-contracts'

export const INDENT_PX = 20
export const BASE_PAD = 4
export const DEFAULT_SIDEBAR_WIDTH = 300

/**
 * Forced color-scheme cycle for the HTML preview header toggle, mirroring
 * task-browser's per-tab `THEME_CYCLE`. 'system' = no override (persists as
 * NULL on `html_theme_override`, same "override only when it differs from
 * the default" shape as zoom).
 */
export type HtmlArtifactTheme = 'system' | 'dark' | 'light'
export const HTML_THEME_CYCLE: HtmlArtifactTheme[] = ['system', 'dark', 'light']

/** Next state in the cycle after `current`. */
export function nextHtmlTheme(current: HtmlArtifactTheme): HtmlArtifactTheme {
  return HTML_THEME_CYCLE[(HTML_THEME_CYCLE.indexOf(current) + 1) % HTML_THEME_CYCLE.length]
}

export const HTML_THEME_ICONS: Record<HtmlArtifactTheme, typeof Monitor> = {
  system: Monitor,
  dark: Moon,
  light: Sun
}

export const HTML_THEME_LABELS: Record<HtmlArtifactTheme, string> = {
  system: 'System theme',
  dark: 'Dark (forced)',
  light: 'Light (forced)'
}

export const RENDER_MODE_ICONS: Record<RenderMode, typeof FileText> = {
  markdown: FileText,
  code: Code,
  'html-preview': Globe,
  'svg-preview': Image,
  'mermaid-preview': GitBranch,
  image: Image,
  pdf: FileText,
  video: Film,
  audio: Music,
  diff: FileDiff,
  archive: FileArchive,
  font: Type
}
