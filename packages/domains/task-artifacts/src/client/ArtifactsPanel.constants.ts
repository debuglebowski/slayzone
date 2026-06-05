import { FileText, Code, Globe, Image, GitBranch } from 'lucide-react'
import type { RenderMode } from '@slayzone/task/shared'

export const INDENT_PX = 20
export const BASE_PAD = 4
export const DEFAULT_SIDEBAR_WIDTH = 300

export const RENDER_MODE_ICONS: Record<RenderMode, typeof FileText> = {
  markdown: FileText,
  code: Code,
  'html-preview': Globe,
  'svg-preview': Image,
  'mermaid-preview': GitBranch,
  image: Image,
  pdf: FileText
}
