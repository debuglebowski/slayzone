// Minimal terminalModes shim. Returns the built-in default modes so the
// TaskDetailPage terminal-mode Select can render a non-empty trigger and
// tests can switch modes. Custom-mode CRUD is stubbed because the shell
// has no storage for custom modes yet — attempts to create return the
// input unchanged so the renderer optimistic flow completes. cap-migrate-
// all-tests (terminal-core batch) added this.

import { DEFAULT_TERMINAL_MODES } from '@slayzone/terminal/shared'
import type {
  TerminalModeInfo,
  CreateTerminalModeInput,
  UpdateTerminalModeInput,
} from '@slayzone/terminal/shared'

let modes: TerminalModeInfo[] = DEFAULT_TERMINAL_MODES.map((m) => ({ ...m }))

export const terminalModesShim = {
  list: async (): Promise<TerminalModeInfo[]> => modes.map((m) => ({ ...m })),

  get: async (id: string): Promise<TerminalModeInfo | null> => {
    const m = modes.find((x) => x.id === id)
    return m ? { ...m } : null
  },

  create: async (input: CreateTerminalModeInput): Promise<TerminalModeInfo> => {
    const mode: TerminalModeInfo = {
      id: input.id,
      label: input.label,
      type: input.type,
      initialCommand: input.initialCommand ?? null,
      resumeCommand: input.resumeCommand ?? null,
      defaultFlags: input.defaultFlags ?? null,
      enabled: input.enabled ?? true,
      isBuiltin: false,
      order: input.order ?? modes.length,
      patternAttention: input.patternAttention ?? null,
      patternWorking: input.patternWorking ?? null,
      patternError: input.patternError ?? null,
      usageConfig: input.usageConfig ?? null,
    }
    modes = modes.filter((m) => m.id !== input.id).concat(mode)
    return { ...mode }
  },

  update: async (id: string, updates: UpdateTerminalModeInput): Promise<TerminalModeInfo | null> => {
    const idx = modes.findIndex((m) => m.id === id)
    if (idx === -1) return null
    modes[idx] = { ...modes[idx]!, ...updates }
    return { ...modes[idx]! }
  },

  delete: async (id: string): Promise<boolean> => {
    const before = modes.length
    modes = modes.filter((m) => m.id !== id || m.isBuiltin)
    return modes.length < before
  },

  test: async (_command: string): Promise<{ success: boolean; output?: string; error?: string }> => ({
    success: true,
    output: '',
  }),

  restoreDefaults: async (): Promise<void> => {
    modes = DEFAULT_TERMINAL_MODES.map((m) => ({ ...m }))
  },

  resetToDefaultState: async (): Promise<void> => {
    modes = DEFAULT_TERMINAL_MODES.map((m) => ({ ...m }))
  },
}
