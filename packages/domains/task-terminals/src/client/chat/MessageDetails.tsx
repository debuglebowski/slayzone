import { Brain, Clock3, CircleX, Copy, Check } from 'lucide-react'
import { cn, safeClipboardWriteText } from '@slayzone/ui'
import { useState, type ReactNode } from 'react'
import type { TimelineItem } from '@slayzone/terminal/client'
import { useChatView } from './ChatViewContext'
import { useRowUiState } from './row-ui-state'
import { formatTime } from './tool-cards/card-shell'
import { formatTokens } from './usage-format'
import { AnswerFooterPanel } from './answer-footer-panel'

function Detail({ children, first = false }: { children: ReactNode; first?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {!first && (
        <span aria-hidden="true" className="text-muted-foreground/40">
          ·
        </span>
      )}
      {children}
    </span>
  )
}

export function MessageDetails({
  item,
  standalone = false
}: {
  item: Extract<TimelineItem, { kind: 'result' }>
  standalone?: boolean
}) {
  const { showMessageMeta } = useChatView()
  const [expanded, setExpanded] = useRowUiState('meta', false, false)
  const [copied, setCopied] = useState(false)
  if (!showMessageMeta) return null
  return (
    <div className="contents">
      <button
        type="button"
        aria-label="Message details"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'inline-flex min-h-7 flex-wrap items-center gap-x-1.5 gap-y-1 text-left text-[11px] text-muted-foreground/70 hover:text-foreground tabular-nums',
          item.isError && 'text-destructive'
        )}
      >
        {item.isError && <CircleX className="size-3" />}
        {item.model && (
          <Detail first>
            <span className="inline-flex items-center gap-1">
              <Brain className="size-3 text-agent-foreground" />
              {item.model}
            </span>
          </Detail>
        )}
        {item.tokenUsage && (
          <Detail first={!item.model}>
            <span
              title={`${item.tokenUsage.inputTokens.toLocaleString()} input · ${item.tokenUsage.outputTokens.toLocaleString()} output`}
            >
              {formatTokens(item.tokenUsage.inputTokens + item.tokenUsage.outputTokens)} tokens
            </span>
          </Detail>
        )}
        <Detail first={!item.model && !item.tokenUsage}>
          <span className="inline-flex items-center gap-1">
            <Clock3 className="size-3 text-info-foreground" />
            {(item.durationMs / 1000).toFixed(1)}s
          </span>
        </Detail>
        <Detail>
          <span>
            {item.numTurns} turn{item.numTurns === 1 ? '' : 's'}
          </span>
        </Detail>
        {item.turnCostUsd !== undefined && (
          <Detail>
            <span data-testid="chat-turn-cost">${item.turnCostUsd.toFixed(4)}</span>
          </Detail>
        )}
        <Detail>
          <time
            dateTime={new Date(item.timestamp).toISOString()}
            title={new Date(item.timestamp).toLocaleString()}
          >
            {formatTime(item.timestamp)}
          </time>
        </Detail>
        {item.isError && (
          <Detail>
            <span>{item.subtype}</span>
          </Detail>
        )}
      </button>
      {standalone && item.copyText && (
        <button
          type="button"
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          aria-label="Copy assistant reply"
          onClick={() => {
            void safeClipboardWriteText(item.copyText!).then(() => setCopied(true))
          }}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      )}
      {expanded && item.text && (
        <AnswerFooterPanel>
          <div className="order-1 basis-full mt-1.5 text-xs text-foreground/80 whitespace-pre-wrap pl-2 border-l border-border/40">
            {item.text}
          </div>
        </AnswerFooterPanel>
      )}
    </div>
  )
}
