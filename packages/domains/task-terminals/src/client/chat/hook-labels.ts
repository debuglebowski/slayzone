import type { TimelineItem } from '@slayzone/terminal/client'

/**
 * How a hook run is named and coloured: the hook row (`HookOutputRow`) and a
 * tool card showing the hook's block (`ToolShell`) say it the same way.
 */
type HookItem = Extract<TimelineItem, { kind: 'hook' }>

/** What a hook's block stopped from happening, by hook event (`agent` = who the chat talks to). */
const BLOCKED_WHAT: Record<string, (agent: string) => string> = {
  PreToolUse: () => 'blocked the tool call',
  PostToolUse: () => 'flagged the tool result',
  UserPromptSubmit: () => 'blocked your message',
  Stop: (agent) => `kept ${agent} working`,
  SubagentStop: () => 'kept the sub-agent working',
  PermissionRequest: () => 'denied the permission request'
}

/** `agent`: how the chat names its agent (`ChatProviderInfo.agent`). */
export function hookLabel(
  item: Pick<HookItem, 'hookName' | 'hookEvent' | 'effect' | 'exitCode' | 'text'>,
  agent: string
): string {
  const name = `${item.hookName} hook`
  switch (item.effect) {
    case 'blocked':
      return `${name} ${BLOCKED_WHAT[item.hookEvent]?.(agent) ?? 'blocked this'}`
    case 'failed':
      return `${name} failed${item.exitCode != null ? ` (exit ${item.exitCode})` : ''}`
    case 'cancelled':
      return `${name} timed out or was cancelled`
    case 'stopped':
      return `${name} stopped ${agent}`
    case 'context': {
      const lines = item.text.split('\n').length
      return `${name} added context for ${agent} · ${lines} line${lines === 1 ? '' : 's'}`
    }
  }
}

export const HOOK_TONE: Record<HookItem['effect'], string> = {
  blocked: 'border-warning/40 bg-warning/10 text-warning-foreground',
  stopped: 'border-warning/40 bg-warning/10 text-warning-foreground',
  cancelled: 'border-warning/30 bg-warning/5 text-warning-foreground',
  failed: 'border-destructive/40 bg-destructive/5 text-destructive',
  context: 'border-border/50 bg-muted/20 text-muted-foreground'
}
