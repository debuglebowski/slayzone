export interface DirEntry {
  name: string
  /** Relative path from project root (e.g. "src/main/index.ts") */
  path: string
  type: 'file' | 'directory'
  /** True if matched by .gitignore */
  ignored?: boolean
  /** True if this entry is a symbolic link */
  isSymlink?: boolean
}

export interface ReadFileResult {
  content: string | null
  tooLarge?: boolean
  sizeBytes?: number
}

export interface FileSearchMatch {
  line: number
  col: number
  lineText: string
}

export interface FileSearchResult {
  path: string
  matches: FileSearchMatch[]
}

export interface SearchFilesOptions {
  matchCase?: boolean
  regex?: boolean
  maxResults?: number
}

export interface OpenFilePosition {
  /** 1-based line number */
  line: number
  /** 0-based column offset (default 0) */
  col?: number
}

export interface OpenFileOptions {
  position?: OpenFilePosition
  from?: 'sidebar' | 'keybind' | 'link' | 'terminal' | 'search'
}

export type GitFileStatus = 'modified' | 'staged' | 'untracked' | 'added' | 'deleted' | 'renamed' | 'conflicted'

export interface GitStatusMap {
  files: Record<string, GitFileStatus>
  isGitRepo: boolean
}

export type MarkdownViewMode = 'rich' | 'split' | 'code'

export interface EditorOpenFilesState {
  files: string[]
  activeFile: string | null
  treeWidth?: number
  treeVisible?: boolean
  expandedFolders?: string[]
  fileViewModes?: Record<string, MarkdownViewMode>
}
