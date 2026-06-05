import type { MutableRefObject } from 'react'
import type { Editor } from '@milkdown/core'
import type { EditorThemeColors } from './editor-themes'
import type { ArtifactPickerItem } from './ArtifactPicker'

export interface FormatState {
  bold: boolean
  italic: boolean
  bulletList: boolean
  orderedList: boolean
  taskList: boolean
}

export interface RichTextEditorProps {
  value: string
  onChange: (markdown: string) => void
  onBlur?: () => void
  placeholder?: string
  className?: string
  minHeight?: string
  maxHeight?: string
  testId?: string
  autoFocus?: boolean
  editorRef?: MutableRefObject<Editor | null>
  onReady?: (editor: Editor) => void
  /** Chrome preset. 'page' = Notion-like page (default). 'inline' = constrained sidebar chrome. */
  variant?: 'page' | 'inline'
  /** Y-axis density (text size, line height, vertical padding). */
  readability?: 'compact' | 'normal'
  /** X-axis width (column max-width, horizontal padding). */
  width?: 'narrow' | 'wide'
  fontFamily?: 'sans' | 'mono'
  checkedHighlight?: boolean
  showToolbar?: boolean
  spellcheck?: boolean
  themeColors?: EditorThemeColors
  artifacts?: ArtifactPickerItem[]
  onArtifactClick?: (artifactId: string) => void
  /** In-editor search query. Non-empty values highlight matches. */
  searchQuery?: string
  /** Index of the active match (used to scroll into view and paint the active color). */
  searchActiveIndex?: number
  /** Treat the query as case-sensitive. */
  searchMatchCase?: boolean
  /** Treat the query as a regular expression. */
  searchRegex?: boolean
  /** Called when the number of matches changes. */
  onSearchMatchCountChange?: (count: number) => void
  /** Called when image files are pasted/dropped. Return inserted artifact refs in order. */
  onUploadImages?: (files: File[]) => Promise<Array<{ id: string; title: string }>>
  /** Enable YAML frontmatter parsing/rendering (`--- ... ---` blocks at top of doc). */
  frontmatter?: boolean
  /** Resolve relative `src`/`href` of inline HTML to absolute URLs (e.g. `slz-file://...`). */
  htmlResolveSrc?: (src: string) => string
  /** Click handler for inline HTML links + images. Receives the resolved href. */
  htmlOnLinkClick?: (resolvedHref: string) => void
  /** Cmd+S / Ctrl+S handler installed on the editor DOM. */
  onSave?: () => void
}
