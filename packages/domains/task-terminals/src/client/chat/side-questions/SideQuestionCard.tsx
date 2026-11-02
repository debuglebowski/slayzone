import { useEffect, useRef } from 'react'
import { Loader2, MessageCircleMore, X } from 'lucide-react'
import { GhMarkdown } from '@slayzone/markdown/client'
import type { SideExchange } from './useSideQuestions'

/**
 * The open side discussion (`/btw`), docked above the composer: each question
 * with its answer. Not part of the conversation — closing it (× or Esc) drops
 * it and stops questions still running.
 */
export function SideQuestionCard({
  exchanges,
  onDismiss
}: {
  exchanges: SideExchange[]
  onDismiss: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // The newest exchange (or its answer arriving) scrolls into view.
  const last = exchanges.at(-1)
  const lastKey = last ? `${last.id}:${last.status}` : ''
  useEffect(() => {
    const el = scrollRef.current
    if (el && lastKey) el.scrollTop = el.scrollHeight
  }, [lastKey])

  return (
    <section
      data-testid="side-question-card"
      aria-label="Side question"
      // Same column as the composer it docks onto (ChatComposer's fixed maximum).
      className="mx-auto mb-2 w-full max-w-[60rem] rounded-2xl border border-border bg-card shadow-sm"
    >
      <div className="flex items-center gap-1.5 px-3 pt-2 text-[11px] text-muted-foreground">
        <MessageCircleMore className="size-3" />
        <span>Side question · not added to the conversation</span>
        <span className="ml-auto">Esc to close</span>
        <button
          type="button"
          aria-label="Close side question"
          data-testid="side-question-close"
          onClick={onDismiss}
          className="rounded p-0.5 hover:bg-accent hover:text-accent-foreground"
        >
          <X className="size-3" />
        </button>
      </div>
      <div ref={scrollRef} className="max-h-[45vh] overflow-y-auto px-3 pb-2.5 pt-1.5">
        {exchanges.map((e) => (
          <div key={e.id} data-testid="side-question-exchange" className="mt-1.5 first:mt-0">
            <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
              /btw {e.question}
            </div>
            <div className="mt-1" data-testid="side-question-answer" data-status={e.status}>
              {e.status === 'asking' && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  Thinking…
                </span>
              )}
              {e.status === 'failed' && (
                <span className="text-xs text-destructive">{e.error ?? 'No answer'}</span>
              )}
              {e.status === 'answered' &&
                (e.answer ? (
                  <div className="text-sm leading-relaxed [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:my-3 [&_ul]:my-2 [&_ol]:my-2 [&_code]:font-mono [&_code]:text-[0.85em]">
                    <GhMarkdown>{e.answer}</GhMarkdown>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">No answer.</span>
                ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
