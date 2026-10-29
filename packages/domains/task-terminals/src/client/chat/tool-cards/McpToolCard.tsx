import { Plug } from 'lucide-react'
import { LinkText, ToolShell, type ToolProps } from './card-shell'
import { mcpResultBlocks, parseMcpToolName, type McpBlock } from './mcp'

function InputValue({ value }: { value: unknown }) {
  if (typeof value === 'string') {
    return (
      <span className="whitespace-pre-wrap break-words">
        <LinkText text={value} />
      </span>
    )
  }
  if (value === null || typeof value !== 'object') {
    return <span className="font-mono">{String(value)}</span>
  }
  return (
    <pre className="max-h-48 overflow-y-auto rounded bg-muted/30 p-1.5 font-mono whitespace-pre-wrap">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

function OutputBlock({ block, isError }: { block: McpBlock; isError: boolean }) {
  if (block.kind === 'image') {
    return (
      <img
        src={block.src}
        alt="Tool output"
        className="max-h-64 max-w-full rounded border border-border/50"
      />
    )
  }
  if (block.kind === 'resource') {
    return (
      <div className="grid gap-1">
        <span className="font-mono text-[11px]">
          <LinkText text={block.uri} />
        </span>
        {block.text && <pre className="font-mono whitespace-pre-wrap">{block.text}</pre>}
      </div>
    )
  }
  return (
    <pre
      className={
        isError
          ? 'font-mono whitespace-pre-wrap text-destructive'
          : 'max-h-64 overflow-y-auto font-mono whitespace-pre-wrap'
      }
    >
      {block.kind === 'text' ? <LinkText text={block.text} /> : block.text}
    </pre>
  )
}

/** Short `key: value` list of an input's scalar fields, for the card header. */
function inputSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  return Object.entries(input as Record<string, unknown>)
    .filter(([, v]) => v === null || typeof v !== 'object')
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(', ')
    .slice(0, 120)
}

/** An MCP tool (`mcp__<server>__<tool>`): server + tool name, readable input and output. */
export function McpToolCard({ invocation, timestamp }: ToolProps) {
  const name = parseMcpToolName(invocation.name)
  const input =
    invocation.input && typeof invocation.input === 'object'
      ? (invocation.input as Record<string, unknown>)
      : {}
  const entries = Object.entries(input)
  const blocks = mcpResultBlocks(invocation.result?.rawContent ?? invocation.result?.structured)
  const isError = invocation.result?.isError === true
  return (
    <ToolShell
      icon={<Plug className="size-3" />}
      title={
        <span className="inline-flex items-center gap-1.5">
          <span>{name?.tool ?? invocation.name}</span>
          {name && (
            <span className="rounded-sm bg-muted px-1 text-[10px] font-normal text-muted-foreground">
              {name.server}
            </span>
          )}
        </span>
      }
      invocation={invocation}
      timestamp={timestamp}
      summary={inputSummary(invocation.input)}
    >
      <div className="p-3 grid gap-3 text-xs">
        {entries.length > 0 && (
          <div className="grid gap-1">
            <div className="text-[11px] text-muted-foreground/70">Input</div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {entries.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="font-mono text-muted-foreground">{k}</dt>
                  <dd className="min-w-0">
                    <InputValue value={v} />
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {blocks.length > 0 && (
          <div className="grid gap-1">
            <div className="text-[11px] text-muted-foreground/70">
              {isError ? 'Error' : 'Output'}
            </div>
            {blocks.map((b, i) => (
              <OutputBlock key={i} block={b} isError={isError} />
            ))}
          </div>
        )}
      </div>
    </ToolShell>
  )
}
