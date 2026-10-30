/**
 * What the chat's model and effort pickers offer, from the list `chat.getModels`
 * serves: Claude's fixed list, or the models Codex's CLI reported
 * (`model/list`) with each model's own effort levels. Codex has none before
 * its first run there (the CLI's default model applies: the pill says
 * "Default"). The UI keeps no list of its own for Codex.
 *
 * @module chat/chat-models
 */
import {
  modelsForMode,
  modelSupportsEffortForMode,
  type ChatModelInfo
} from '@slayzone/terminal-contracts'
import type { AgentEffortLevel } from '@slayzone/ui'

export interface ChatModelsView {
  models: ChatModelInfo[]
  /** The provider has listed no models yet. */
  unlisted: boolean
  label: (id: string) => string
  supportsEffort: (id: string) => boolean
  /** The model's own effort levels; undefined: the provider's fixed set (Claude). */
  effortLevels: (id: string) => AgentEffortLevel[] | undefined
}

/** Modes whose model list comes from the CLI itself, not from the app. */
const CLI_LISTED_MODES = new Set(['codex-chat'])

export function chatModelsView(mode: string, served: ChatModelInfo[] | undefined): ChatModelsView {
  const cliListed = CLI_LISTED_MODES.has(mode)
  const models: ChatModelInfo[] =
    served && served.length > 0 ? served : cliListed ? [] : modelsForMode(mode)
  const find = (id: string) => models.find((m) => m.id === id)
  return {
    models,
    unlisted: cliListed && models.length === 0,
    label: (id) => find(id)?.label ?? id,
    supportsEffort: (id) => {
      const m = find(id)
      if (m) return m.supportsEffort && (!cliListed || (m.efforts?.length ?? 0) > 0)
      return cliListed ? false : modelSupportsEffortForMode(mode, id)
    },
    effortLevels: (id) => find(id)?.efforts
  }
}
