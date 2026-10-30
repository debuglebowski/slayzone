/**
 * Provider-aware chat model catalog. `claude-chat` and `codex-chat` expose
 * different model sets, defaults, and validity rules — this keys them by
 * terminal mode so the model picker, the IPC handlers, and the spawn path all
 * resolve the right list per provider.
 *
 * Claude models mirror `chat-model.ts` (`claude --model` aliases). Codex's
 * models come from its CLI (`model/list`, served by `chat.getModels`); no app
 * (desktop or phone) keeps a Codex list of its own — `chatModelsView` turns
 * the served list into what the pickers offer.
 *
 * @module shared/chat-model-catalog
 */
import { CHAT_EFFORTS } from './chat-effort'
import { chatProviderForMode } from './chat-provider'

export interface ChatModelOption {
  /** Model id passed to the provider (`claude --model` alias / Codex model id). */
  id: string
  /** Display label for the picker. */
  label: string
  /** Whether the model exposes a reasoning-effort lever. */
  supportsEffort: boolean
}

/**
 * A model as the model picker offers it, with what the provider says about it:
 * Claude's static list, or the CLI's own `model/list` (Codex, `chat.getModels`).
 */
export interface ChatModelInfo extends ChatModelOption {
  /** One line about the model (Codex `description`). */
  description?: string
  /** The provider's default for this account (Codex `isDefault`). */
  isDefault?: boolean
  /** Reasoning efforts this model accepts, in the CLI's order. Absent: the provider's fixed set. */
  efforts?: ChatModelEffort[]
  /** The model's own default effort (Codex `defaultReasoningEffort`). */
  defaultEffort?: string
}

/** One reasoning effort a model accepts (Codex: any string the model lists, e.g. `ultra`). */
export interface ChatModelEffort {
  /** Value sent to the provider (Codex `turn/start.effort`). */
  id: string
  /** Display label (the id, title-cased: `xhigh` → `Xhigh`). */
  label: string
  /** The CLI's description of it. */
  description?: string
}

const CLAUDE_MODELS: ChatModelOption[] = [
  { id: 'opus', label: 'Opus', supportsEffort: true },
  { id: 'sonnet', label: 'Sonnet', supportsEffort: true },
  { id: 'haiku', label: 'Haiku', supportsEffort: false }
]

/** Modes whose model list comes from the CLI itself (`chat.getModels`), not from the app. */
const CLI_LISTED_MODES = new Set(['codex-chat'])

/**
 * The app's own models for a terminal mode: Claude's fixed list; none for a
 * mode whose CLI lists them (Codex — read `chat.getModels`).
 */
export function modelsForMode(mode: string): ChatModelOption[] {
  return CLI_LISTED_MODES.has(mode) ? [] : CLAUDE_MODELS
}

/** True when `v` is a model id valid for the given mode. */
export function isValidModelForMode(mode: string, v: unknown): v is string {
  return typeof v === 'string' && modelsForMode(mode).some((m) => m.id === v)
}

/** Display label for a model id, falling back to the raw id. */
export function modelLabelForMode(mode: string, id: string): string {
  return modelsForMode(mode).find((m) => m.id === id)?.label ?? id
}

/** Whether a model id supports the reasoning-effort lever within its mode. */
export function modelSupportsEffortForMode(mode: string, id: string): boolean {
  const entry = modelsForMode(mode).find((m) => m.id === id)
  return entry ? entry.supportsEffort : true
}

/** What a chat's model and effort pickers offer (desktop pills, phone chips). */
export interface ChatModelsView {
  models: ChatModelInfo[]
  /** The provider has listed no models yet. */
  unlisted: boolean
  label: (id: string) => string
  supportsEffort: (id: string) => boolean
  /** The model's own effort levels; undefined: the provider's fixed set (Claude). */
  effortLevels: (id: string) => ChatModelEffort[] | undefined
  /**
   * What `/effort <level>` does on `model` (desktop composer, phone `planSend`): the
   * model's own levels where the provider lists them (Codex) — a model with none, or
   * none listed yet, refuses; Claude's fixed levels otherwise.
   */
  effortCommand: (model: string | null, level: string) => EffortCommandResult
}

/** `/effort <level>`: the level to set, or why not. */
export type EffortCommandResult = { ok: true; level: string } | { ok: false; message: string }

/**
 * The pickers' view of the list `chat.getModels` serves: Claude's fixed list,
 * or the models Codex's CLI reported (`model/list`) with each model's own
 * effort levels. Codex has none before its first run there (the CLI's default
 * model applies: the picker says "Default").
 */
export function chatModelsView(mode: string, served: ChatModelInfo[] | undefined): ChatModelsView {
  const cliListed = CLI_LISTED_MODES.has(mode)
  const models: ChatModelInfo[] = served && served.length > 0 ? served : modelsForMode(mode)
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
    effortLevels: (id) => find(id)?.efforts,
    effortCommand: (model, raw) => {
      const level = raw.toLowerCase()
      const listed = model ? find(model)?.efforts : undefined
      // A CLI-listed provider's levels are per model: never Claude's as a fallback.
      const valid: readonly string[] = listed
        ? listed.map((l) => l.id)
        : cliListed
          ? []
          : CHAT_EFFORTS
      if (valid.includes(level)) return { ok: true, level }
      if (valid.length > 0) {
        return { ok: false, message: `Invalid effort level "${level}". Use: ${valid.join(', ')}` }
      }
      if (models.length === 0 || !model) {
        return {
          ok: false,
          message: `No effort levels yet: ${chatProviderForMode(mode).product} lists its models once it has started.`
        }
      }
      return { ok: false, message: `${find(model)?.label ?? model} has no effort levels.` }
    }
  }
}
