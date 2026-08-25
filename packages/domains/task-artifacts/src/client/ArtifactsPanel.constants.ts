import { FileText, Code, Globe, Image, GitBranch, Monitor, Moon, Sun } from 'lucide-react'
import type { RenderMode } from '@slayzone/task/shared'

export const INDENT_PX = 20
export const BASE_PAD = 4
export const DEFAULT_SIDEBAR_WIDTH = 300

/**
 * Zoom ladder for the artifact header control, mirroring Chromium's own browser
 * zoom steps so the increments feel native. Stepping walks this list rather than
 * adding a fixed delta — a constant +10% is too coarse at 50% and too fine at
 * 300%.
 */
export const ZOOM_STEPS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300]
export const DEFAULT_ZOOM_PCT = 100

/** Nearest ladder step in `dir` from `pct`, clamped at both ends. */
export function stepZoom(pct: number, dir: 1 | -1): number {
  const next =
    dir === 1 ? ZOOM_STEPS.find((s) => s > pct) : [...ZOOM_STEPS].reverse().find((s) => s < pct)
  return next ?? (dir === 1 ? ZOOM_STEPS[ZOOM_STEPS.length - 1] : ZOOM_STEPS[0])
}

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
  pdf: FileText
}
