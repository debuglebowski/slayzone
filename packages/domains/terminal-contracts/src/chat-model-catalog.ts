/**
 * Provider-aware chat model catalog. `claude-chat` and `codex-chat` expose
 * different model sets, defaults, and validity rules — this keys them by
 * terminal mode so the model picker, the IPC handlers, and the spawn path all
 * resolve the right list per provider.
 *
 * Claude models mirror `chat-model.ts` (`claude --model` aliases). Codex model
 * ids are verified against `codex app-server`'s `model/list` (codex-cli
 * 0.132.0); re-check on a CLI upgrade — see `test/fixtures/codex-app-server/`.
 *
 * @module shared/chat-model-catalog
 */
import { DEFAULT_CHAT_MODEL } from './chat-model'

export interface ChatModelOption {
  /** Model id passed to the provider (`claude --model` alias / Codex model id). */
  id: string
  /** Display label for the picker. */
  label: string
  /** Whether the model exposes a reasoning-effort lever. */
  supportsEffort: boolean
}

const CLAUDE_MODELS: ChatModelOption[] = [
  { id: 'opus', label: 'Opus', supportsEffort: true },
  { id: 'sonnet', label: 'Sonnet', supportsEffort: true },
  { id: 'haiku', label: 'Haiku', supportsEffort: false }
]

const CODEX_MODELS: ChatModelOption[] = [
  { id: 'gpt-5.5', label: 'GPT-5.5', supportsEffort: true },
  { id: 'gpt-5.4', label: 'GPT-5.4', supportsEffort: true },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', supportsEffort: true },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', supportsEffort: true }
]

/** Codex's own default (`isDefault` in `model/list`). */
const CODEX_DEFAULT_MODEL = 'gpt-5.5'

/** Models offered for a terminal mode. Codex modes get the Codex set; all else Claude. */
export function modelsForMode(mode: string): ChatModelOption[] {
  return mode === 'codex-chat' ? CODEX_MODELS : CLAUDE_MODELS
}

/** Fallback model id for a mode when nothing is stored. */
export function defaultModelForMode(mode: string): string {
  return mode === 'codex-chat' ? CODEX_DEFAULT_MODEL : DEFAULT_CHAT_MODEL
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
