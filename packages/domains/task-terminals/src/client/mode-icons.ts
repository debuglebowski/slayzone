import type { ComponentType } from 'react'
import { Terminal as TerminalIcon } from 'lucide-react'
import ClaudeColor from '@lobehub/icons/es/Claude/components/Color'
import CodexColor from '@lobehub/icons/es/Codex/components/Color'
import GeminiColor from '@lobehub/icons/es/Gemini/components/Color'
import CopilotColor from '@lobehub/icons/es/Copilot/components/Color'
import CursorMono from '@lobehub/icons/es/Cursor/components/Mono'
import OpenCodeMono from '@lobehub/icons/es/OpenCode/components/Mono'
import type { AgentId } from '@slayzone/terminal-contracts'

export type ModeIconComponent = ComponentType<{ className?: string }>

/** Provider logo per agent. */
export const MODE_ICONS: Partial<Record<AgentId, ModeIconComponent>> = {
  'claude-code': ClaudeColor as ModeIconComponent,
  'claude-chat': ClaudeColor as ModeIconComponent,
  codex: CodexColor as ModeIconComponent,
  'codex-chat': CodexColor as ModeIconComponent,
  'cursor-agent': CursorMono as ModeIconComponent,
  gemini: GeminiColor as ModeIconComponent,
  opencode: OpenCodeMono as ModeIconComponent,
  copilot: CopilotColor as ModeIconComponent,
  terminal: TerminalIcon
}
