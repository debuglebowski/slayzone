import { useId, type ReactNode } from 'react'
import { ClipboardList, Loader2 } from 'lucide-react'
import { GhMarkdown } from '@slayzone/markdown/client'
import { renderCodexFileCitations } from './codex-file-citations'

/** Shared presentation for final plans, distinct from progress checklists. */
export function FinalPlanCard({
  text,
  streaming = false,
  status,
  footer
}: {
  text: string
  streaming?: boolean
  status?: ReactNode
  footer?: ReactNode
}) {
  const titleId = useId()
  return (
    <section
      aria-labelledby={titleId}
      className="min-w-0 flex-1 overflow-hidden rounded-xl border border-warning/25 bg-card shadow-sm"
    >
      <div className="flex items-center gap-2.5 border-b border-warning/15 bg-warning/5 px-4 py-3">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-warning/10 text-warning-foreground">
          <ClipboardList className="size-4" />
        </div>
        <span id={titleId} className="text-xs font-semibold text-foreground">
          Final plan
        </span>
        <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          {streaming ? (
            <>
              <Loader2 className="size-3 animate-spin" />
              <span>Writing…</span>
            </>
          ) : (
            status
          )}
        </div>
      </div>
      {text && (
        <div
          data-chat-text
          data-streaming={streaming ? 'true' : undefined}
          className="px-4 py-4 text-sm leading-relaxed sm:px-5 [&_p]:my-3 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:my-3 [&_ul]:my-3 [&_ol]:my-3 [&_li]:my-1 [&_h1]:mt-0 [&_h1]:mb-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:text-sm [&_h3]:font-medium [&_code]:font-mono [&_code]:text-[0.85em]"
        >
          <GhMarkdown>{renderCodexFileCitations(text)}</GhMarkdown>
        </div>
      )}
      {footer && (
        <div className="border-t border-warning/15 bg-warning/5 px-4 py-2.5">{footer}</div>
      )}
    </section>
  )
}
