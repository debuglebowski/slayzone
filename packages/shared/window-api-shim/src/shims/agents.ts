// Minimal agents shim. Returns the built-in default agents so the
// TaskDetailPage agent Select can render a non-empty trigger and
// tests can switch agents. Custom-agent CRUD is stubbed because the shell
// has no storage for custom agents yet — attempts to create return the
// input unchanged so the renderer optimistic flow completes. cap-migrate-
// all-tests (terminal-core batch) added this.

import { DEFAULT_AGENTS } from '@slayzone/terminal-contracts'
import type {
  AgentDefinition,
  CreateAgentDefinitionInput,
  UpdateAgentDefinitionInput
} from '@slayzone/terminal-contracts'

let modes: AgentDefinition[] = DEFAULT_AGENTS.map((m) => ({ ...m }))

export const agentsShim = {
  list: async (): Promise<AgentDefinition[]> => modes.map((m) => ({ ...m })),

  get: async (id: string): Promise<AgentDefinition | null> => {
    const m = modes.find((x) => x.id === id)
    return m ? { ...m } : null
  },

  create: async (input: CreateAgentDefinitionInput): Promise<AgentDefinition> => {
    const mode: AgentDefinition = {
      id: input.id,
      label: input.label,
      type: input.type,
      initialCommand: input.initialCommand ?? null,
      resumeCommand: input.resumeCommand ?? null,
      headlessCommand: input.headlessCommand ?? null,
      defaultFlags: input.defaultFlags ?? null,
      enabled: input.enabled ?? true,
      isBuiltin: false,
      order: input.order ?? modes.length,
      patternWorking: input.patternWorking ?? null,
      patternError: input.patternError ?? null,
      usageConfig: input.usageConfig ?? null
    }
    modes = modes.filter((m) => m.id !== input.id).concat(mode)
    return { ...mode }
  },

  update: async (
    id: string,
    updates: UpdateAgentDefinitionInput
  ): Promise<AgentDefinition | null> => {
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

  test: async (
    _command: string
  ): Promise<{ success: boolean; output?: string; error?: string }> => ({
    success: true,
    output: ''
  }),

  restoreDefaults: async (): Promise<void> => {
    modes = DEFAULT_AGENTS.map((m) => ({ ...m }))
  },

  resetToDefaultState: async (): Promise<void> => {
    modes = DEFAULT_AGENTS.map((m) => ({ ...m }))
  }
}
