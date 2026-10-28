export type MarkdownViewMode = 'rich' | 'split' | 'code'

export interface EditorOpenFilesState {
  files: string[]
  activeFile: string | null
  treeWidth?: number
  treeVisible?: boolean
  expandedFolders?: string[]
  fileViewModes?: Record<string, MarkdownViewMode>
  tocWidth?: number
}
