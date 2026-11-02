import type { DiagnosticEvent } from '../shared'

const contentKeys = new Set([
  'text',
  'content',
  'message',
  'prompt',
  'input',
  'output',
  'stdout',
  'stderr',
  'error',
  'stack',
  'componentStack',
  'snapshot',
  'screenshotDataUrl',
  'url',
  'body',
  'args',
  'arguments',
  'result',
  'raw',
  'command',
  'headers',
  'token',
  'payload'
])
const containers = new Set([
  'context',
  'stats',
  'metrics',
  'counts',
  'layout',
  'flags',
  'chat',
  'session',
  'paging',
  'anchor',
  'viewport'
])
const vocabulary = new Set([
  'claude-chat',
  'codex-chat',
  'claude-code',
  'codex',
  'idle',
  'starting',
  'running',
  'stopped',
  'dead',
  'error',
  'ready',
  'loading',
  'queued',
  'delivered',
  'answered',
  'cancelled',
  'failed',
  'pending',
  'full',
  'paged',
  'success',
  'failure',
  'allow',
  'deny',
  'plan',
  'default',
  'auto-accept',
  'bypass',
  'dont-ask',
  'user-message',
  'user-message-delivery',
  'assistant-text',
  'turn-init',
  'result',
  'permission-request',
  'permission-resolved',
  'tool-use',
  'tool-result',
  'workspace-changes',
  'session-spawn',
  'session-ready',
  'session-ended',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Stop',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'Notification'
])
function metadata(value: unknown, depth = 0): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 4) return {}
  const safe: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, 200)) {
    if (contentKeys.has(key) || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) continue
    if (key === 'frames' && Array.isArray(item)) {
      safe.frames = item
        .filter(
          (frame) =>
            typeof frame === 'string' &&
            /^[A-Za-z0-9_.-]+\.(?:js|jsx|ts|tsx|html):\d+:\d+$/.test(frame)
        )
        .slice(0, 40)
      continue
    }
    if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)))
      safe[key] = item
    else if (typeof item === 'string') {
      if ((key === 'id' || /Ids?$/.test(key)) && /^[A-Za-z0-9._:/-]{1,200}$/.test(item))
        safe[key] = item
      else if (vocabulary.has(item)) safe[key] = item
      else if (['path', 'route', 'op', 'method'].includes(key) && /^chat\.[A-Za-z.]+$/.test(item))
        safe[key] = item
    } else if (containers.has(key)) safe[key] = metadata(item, depth + 1)
  }
  return safe
}
function stackFrames(payload: unknown): string[] {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('stack' in payload) ||
    typeof payload.stack !== 'string'
  )
    return []
  return payload.stack
    .split('\n')
    .slice(1, 41)
    .flatMap((line) => {
      const match = /\bat .*[\\/]([A-Za-z0-9_.-]+\.(?:js|jsx|ts|tsx|html)):(\d+):(\d+)\)?\s*$/.exec(
        line
      )
      return match ? [`${match[1]}:${match[2]}:${match[3]}`] : []
    })
}

/** Apply before queueing/offloading blobs. Renderer snapshots may show several hubs' chats. */
export function chatSafeDiagnostic(event: DiagnosticEvent): DiagnosticEvent {
  const routes =
    event.payload && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)
      : {}
  const isChat =
    event.event.startsWith('chat.') ||
    event.event.startsWith('renderer.') ||
    event.source === 'renderer' ||
    event.event === 'pty.hook_received' ||
    event.event === 'main.uncaught_exception' ||
    event.event === 'main.unhandled_rejection' ||
    /^chat[.:]/.test(event.channel ?? '') ||
    ['path', 'route', 'op', 'method'].some(
      (key) => typeof routes[key] === 'string' && /(?:^|\/)chat[.:]/.test(String(routes[key]))
    )
  if (!isChat) return event
  const frames = stackFrames(event.payload)
  return {
    ...event,
    message: null,
    payload: { ...metadata(event.payload), ...(frames.length ? { frames } : {}) }
  }
}
