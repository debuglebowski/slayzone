import { FileText, Code, Globe, Image, GitBranch } from 'lucide-react'
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

export const RENDER_MODE_ICONS: Record<RenderMode, typeof FileText> = {
  markdown: FileText,
  code: Code,
  'html-preview': Globe,
  'svg-preview': Image,
  'mermaid-preview': GitBranch,
  image: Image,
  pdf: FileText
}
