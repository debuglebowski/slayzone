/**
 * Words for the chat's mode, model and effort pickers. The ids, their order and which
 * apply come from the shared catalogs (`@slayzone/terminal-contracts`); the labels are
 * desktop's pill copy (`packages/shared/ui/src/agent-mode-pill.tsx`,
 * `agent-effort-pill.tsx`), mirrored here because that package is desktop UI.
 */
import {
  CHAT_EFFORTS,
  type ChatEffort,
  chatModesForMode,
  modelsForMode
} from '@slayzone/terminal-contracts'

export interface ControlOption {
  id: string
  label: string
  description: string
}

const MODE_COPY: Record<string, { label: string; description: string }> = {
  plan: { label: 'Plan mode', description: 'Read-only — investigation phase. No edits, no shell.' },
  ask: {
    label: 'Ask before edits',
    description: 'Claude asks before each edit and command; you answer in the chat.'
  },
  'auto-accept': {
    label: 'Auto-accept edits',
    description: 'Edits and tool calls auto-approved. Recommended default.'
  },
  auto: {
    label: 'Auto mode',
    description: 'Continuous autonomous execution. Requires Max/Team/Enterprise + opt-in.'
  },
  bypass: {
    label: 'Bypass permissions',
    description: 'All permission checks skipped. Use with caution.'
  },
  'approval-required': {
    label: 'Approval required',
    description: 'Read-only sandbox — asks before running commands or edits.'
  },
  'auto-accept-edits': {
    label: 'Auto-accept edits',
    description: 'Edits and commands in the workspace auto-approved.'
  },
  'full-access': {
    label: 'Full access',
    description: 'All actions auto-approved, no sandbox. Use with caution.'
  }
}

const EFFORT_COPY: Record<ChatEffort, { label: string; description: string }> = {
  low: { label: 'Low', description: 'Minimal reasoning. Fastest, cheapest.' },
  medium: { label: 'Medium', description: 'Balanced reasoning depth.' },
  high: { label: 'High', description: 'Deeper reasoning. Slower, higher cost.' },
  xhigh: { label: 'Extra-high', description: 'Extended reasoning depth.' },
  max: { label: 'Max', description: 'Maximum reasoning. Slowest, highest cost.' }
}

/**
 * The permission modes offered for a chat mode, in the picker's order. Claude's `auto`
 * shows only to an eligible account (desktop hides it otherwise).
 */
export function modeOptions(mode: string, autoEligible: boolean): ControlOption[] {
  return chatModesForMode(mode)
    .filter((id) => id !== 'auto' || mode === 'codex-chat' || autoEligible)
    .map((id) => ({ id, ...(MODE_COPY[id] ?? { label: id, description: '' }) }))
}

export function modeLabel(id: string): string {
  return MODE_COPY[id]?.label ?? id
}

export function modelOptions(mode: string): ControlOption[] {
  return modelsForMode(mode).map((m) => ({ id: m.id, label: m.label, description: '' }))
}

export function effortOptions(): ControlOption[] {
  return CHAT_EFFORTS.map((id) => ({ id, ...EFFORT_COPY[id] }))
}

export function effortLabel(id: string): string {
  return EFFORT_COPY[id as ChatEffort]?.label ?? id
}
