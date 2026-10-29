import React from 'react'
import { useChatView } from './ChatViewContext'

/**
 * Wraps occurrences of the active chat-search query with `<mark>` so plain-text
 * surfaces (user messages, thinking blocks, tool input/output, stderr) light up
 * every hit. Markdown-rendered assistant content is *not* funneled through here
 * because injecting `<mark>` into raw markdown source could corrupt token
 * boundaries (e.g. inside `**bold**`); for those surfaces, item-level scroll +
 * border is the highlight signal.
 *
 * No-op when search is closed / query empty.
 */
export function HighlightedText({ text }: { text: string }) {
  const { search } = useChatView()
  if (!search.query) return <>{text}</>
  const needle = search.caseSensitive ? search.query : search.query.toLowerCase()
  if (needle.length === 0) return <>{text}</>

  const out: React.ReactNode[] = []
  const cmp = search.caseSensitive ? text : text.toLowerCase()
  let cursor = 0
  let key = 0
  while (true) {
    const at = cmp.indexOf(needle, cursor)
    if (at < 0) break
    if (at > cursor) out.push(<React.Fragment key={key++}>{text.slice(cursor, at)}</React.Fragment>)
    out.push(
      <mark key={key++} className="bg-search-match text-search-match-foreground rounded-sm px-0.5">
        {text.slice(at, at + needle.length)}
      </mark>
    )
    cursor = at + needle.length
  }
  if (cursor < text.length)
    out.push(<React.Fragment key={key++}>{text.slice(cursor)}</React.Fragment>)
  return <>{out}</>
}
