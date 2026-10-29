import { SquareTerminal } from 'lucide-react'
import { GhMarkdown } from '@slayzone/markdown/client'
import type { TimelineItem } from '@slayzone/terminal/client'

/**
 * True when command output is structured markdown (headings or table rows, like
 * `/context`). Plain-text output (like `/usage`) relies on its line breaks and
 * indentation, which markdown would collapse.
 */
export function looksLikeMarkdown(text: string): boolean {
  return /^#{1,6}\s/m.test(text) || /^\s*\|.*\|\s*$/m.test(text)
}

/** Output of a slash command the CLI ran locally (`/context`, `/usage`, …). */
export function CommandOutputBlock({
  item
}: {
  item: Extract<TimelineItem, { kind: 'command-output' }>
}) {
  return (
    <div className="pl-4 pr-[10%] py-2">
      <div className="flex gap-3 items-start">
        <div className="shrink-0 size-7 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
          <SquareTerminal className="size-3.5" />
        </div>
        <div className="min-w-0 rounded-lg border border-border/50 bg-card/40 px-3 py-2">
          {item.command && (
            <div className="mb-1 font-mono text-[11px] text-muted-foreground">/{item.command}</div>
          )}
          {looksLikeMarkdown(item.text) ? (
            <div className="text-sm leading-relaxed [&_table]:my-2 [&_table]:text-xs [&_th]:px-2 [&_td]:px-2 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-3 [&_h3]:text-sm [&_h3]:font-medium [&_h3]:mt-3 [&_p]:my-2">
              <GhMarkdown>{item.text}</GhMarkdown>
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
              {item.text}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}
