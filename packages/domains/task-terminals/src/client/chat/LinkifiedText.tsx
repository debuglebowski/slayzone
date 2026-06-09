import React from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import { findLinksInString } from '@slayzone/terminal/shared'
import { Tooltip, TooltipContent, TooltipTrigger } from '@slayzone/ui'

interface LinkifiedTextProps {
  text: string
  /** Cmd/Ctrl+click on a URL → in-app slay browser. Falls back to external when undefined. */
  onOpenUrl?: (url: string) => void
  /** Cmd/Ctrl+click on a file path → open in editor pane. Defaults to `app.shell.openPath`. */
  onOpenFile?: (path: string, line?: number, col?: number) => void
}

/**
 * Plain-text renderer that detects URLs + file:line:col references using the
 * shared regex helpers, wraps each match in an anchor element with a Radix
 * tooltip, and routes clicks to the appropriate handler.
 *
 * Modifier semantics mirror the terminal pane:
 *   - Cmd+Click on URL → in-app slay browser (via `onOpenUrl`, falls back to external)
 *   - Cmd+Shift+Click on URL → always external
 *   - Cmd+Click on file → editor (via `onOpenFile`)
 *   - Bare click → no-op (lets text selection through)
 */
export function LinkifiedText({ text, onOpenUrl, onOpenFile }: LinkifiedTextProps) {
  const trpcClient = useTRPCClient()
  const openExternal = (url: string): void => {
    void trpcClient.app.shell.openExternal.mutate({ url })
  }
  const defaultOpenFile = (path: string): void => {
    void trpcClient.app.shell.openPath.mutate({ absPath: path })
  }
  const matches = findLinksInString(text)
  if (matches.length === 0) return <>{text}</>

  const out: React.ReactNode[] = []
  let cursor = 0
  let key = 0
  for (const m of matches) {
    if (m.start > cursor)
      out.push(<React.Fragment key={`t${key++}`}>{text.slice(cursor, m.start)}</React.Fragment>)
    const isUrl = m.kind === 'url'
    const handleClick = (e: React.MouseEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      e.preventDefault()
      if (isUrl) {
        if (e.shiftKey) openExternal(m.text)
        else if (onOpenUrl) onOpenUrl(m.text)
        else openExternal(m.text)
      } else if (m.filePath) {
        ;(onOpenFile ?? defaultOpenFile)(m.filePath, m.line, m.col)
      }
    }
    const label = isUrl
      ? m.text
      : `${m.filePath}${m.line ? `:${m.line}${m.col ? `:${m.col}` : ''}` : ''}`
    out.push(
      <Tooltip key={`l${key++}`}>
        <TooltipTrigger asChild>
          <a
            href={isUrl ? m.text : '#'}
            onClick={handleClick}
            data-linkified="true"
            className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary cursor-pointer"
          >
            {m.text}
          </a>
        </TooltipTrigger>
        <TooltipContent side="top" className="font-mono text-[11px]">
          {isUrl ? '⌘+Click open · ⌘⇧+Click external' : `⌘+Click open: ${label}`}
        </TooltipContent>
      </Tooltip>
    )
    cursor = m.end
  }
  if (cursor < text.length)
    out.push(<React.Fragment key={`t${key++}`}>{text.slice(cursor)}</React.Fragment>)
  return <>{out}</>
}
