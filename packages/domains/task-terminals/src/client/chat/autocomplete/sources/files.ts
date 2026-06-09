import type { FileMatch } from '@slayzone/terminal/shared'
import type { AutocompleteSource, ChatListApi } from '../types'
import { spliceReplace } from '../useAutocomplete'
import { renderFileItem } from './render-file'

/** Detect `@query` token at cursor position. */
function detectFileTrigger(
  draft: string,
  cursorPos: number
): { query: string; tokenStart: number; tokenEnd: number } | null {
  let start = cursorPos
  while (start > 0) {
    const ch = draft[start - 1]
    if (ch === '@') {
      start -= 1
      break
    }
    if (ch === ' ' || ch === '\n' || ch === '\t') return null
    start -= 1
  }
  if (start < 0) return null
  if (draft[start] !== '@') return null
  // `@` must be at start of input or preceded by whitespace.
  if (start > 0) {
    const prev = draft[start - 1]
    if (prev !== ' ' && prev !== '\n' && prev !== '\t') return null
  }
  const query = draft.slice(start + 1, cursorPos)
  return { query, tokenStart: start, tokenEnd: cursorPos }
}

/**
 * File cache keyed by cwd. Main-side IPC already does filtering, but we prefetch
 * once per cwd and re-filter in the renderer to keep keystroke latency to zero.
 * For very large repos (>10k files) we could move filtering main-side.
 */
export function createFilesSource(listApi?: ChatListApi): AutocompleteSource<FileMatch> {
  return {
    id: 'files',
    detect: detectFileTrigger,
    async fetch({ cwd }) {
      if (!listApi) return []
      // Prefetch w/ empty query, cap 2000. Source filters locally.
      return listApi.listFiles(cwd, '', 2000)
    },
    filter(items, query) {
      if (!query) return items.slice(0, 50)
      const q = query.toLowerCase()
      return items
        .map((f) => {
          const base = f.path.split('/').pop()?.toLowerCase() ?? ''
          const full = f.path.toLowerCase()
          let score = 0
          if (base.startsWith(q)) score = 3
          else if (base.includes(q)) score = 2
          else if (full.includes(q)) score = 1
          return { f, score }
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.f.path.localeCompare(b.f.path))
        .slice(0, 50)
        .map((x) => x.f)
    },
    getKey: (f) => f.path,
    render: renderFileItem,
    accept(file, ctx) {
      // Replace `@query` with `@path ` so user can keep typing after.
      const next = spliceReplace(ctx.draft, ctx.tokenStart, ctx.tokenEnd, `@${file.path} `)
      ctx.setDraft(next)
    }
  }
}
