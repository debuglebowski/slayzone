import { z } from 'zod'

export const textRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const MAX_TEXT_EDIT_BYTES = 10 * 1024 * 1024
export const textEditSchema = z.object({
  revision: textRevisionSchema,
  from: z.number().int().nonnegative().max(MAX_TEXT_EDIT_BYTES),
  to: z.number().int().nonnegative().max(MAX_TEXT_EDIT_BYTES),
  text: z.string().max(MAX_TEXT_EDIT_BYTES)
})
export type TextEdit = z.infer<typeof textEditSchema>

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
  revision?: string
  /** The requested revision still applies. The content was omitted. */
  unchanged?: true
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

export type GitFileStatus =
  | 'modified'
  | 'staged'
  | 'untracked'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'conflicted'

export interface GitStatusMap {
  files: Record<string, GitFileStatus>
  isGitRepo: boolean
}

export type { MarkdownViewMode, EditorOpenFilesState } from '@slayzone/task-contracts'
