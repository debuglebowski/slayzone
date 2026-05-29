/**
 * Terminal state styling - shared between TabBar and KanbanCard
 */

export type TerminalStateStyle = {
  color: string
  textColor: string
  label: string
}

const TERMINAL_STATE_STYLES: Record<string, TerminalStateStyle> = {
  dead: { color: 'bg-gray-400', textColor: 'text-gray-500', label: 'Stopped' },
  starting: { color: 'bg-gray-400', textColor: 'text-green-500', label: 'Starting' },
  running: { color: 'bg-green-400 animate-pulse', textColor: 'text-green-500', label: 'Active' },
  idle: { color: 'bg-sky-400', textColor: 'text-sky-500', label: 'Idle' },
  error: { color: 'bg-red-400', textColor: 'text-red-500', label: 'Error' },
  // Idle-closed to free memory; reopen resumes. Rendered as a 💤 emoji
  // (not a dot) by TerminalProgressDot — color/textColor are unused there.
  hibernated: { color: 'bg-violet-400', textColor: 'text-violet-500', label: 'Sleeping' }
}

export const ATTENTION_STATE_STYLE: TerminalStateStyle = {
  color: 'bg-amber-400 animate-pulse',
  textColor: 'text-amber-500',
  label: 'Unread'
}

export function getTerminalStateStyle(state: string | undefined): TerminalStateStyle | null {
  if (!state) return null
  return TERMINAL_STATE_STYLES[state] ?? null
}
