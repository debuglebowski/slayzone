/**
 * Interactive first-run setup for the STANDALONE hub + runner bins.
 *
 * When a standalone `slayzone-hub` / `slayzone-runner` boots on an interactive
 * terminal and a required (runner) or recommended (hub) value is missing, the
 * bin prompts for it, prints a summary, and — after a `[Y/n]` confirmation —
 * persists it to `<ROOT>/config.json` via {@link updateSlayzoneConfig}. Values
 * collected this run are also seeded into `process.env` so the bin's EXISTING
 * config-resolution path (which reads env) picks them up unchanged — the prompt
 * is just an interactive env producer sitting at the very top of the pipeline.
 *
 * NEVER interactive when: stdin is not a TTY (CI, pipes, the install-handshake
 * test's piped stdio), the Electron host supervises the bin
 * (`SLAYZONE_SUPERVISED=1`), or the operator opts out (`SLAYZONE_NONINTERACTIVE=1`).
 * In every non-interactive case the caller skips this module entirely and the
 * boot stays byte-identical to today (auto-gen / fail-fast).
 *
 * Lives in @slayzone/platform and is exposed on the lean `./config-prompt`
 * SUBPATH so the runner bundle can import it WITHOUT pulling the platform barrel
 * (which references better-sqlite3). It depends only on `./slayzone-config` +
 * node builtins.
 *
 * @module platform/config-prompt
 */

import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import {
  getSlayzoneConfigPath,
  updateSlayzoneConfig,
  type SlayzoneConfig
} from './slayzone-config'

/**
 * Minimal line-based console IO. The default implementation wraps
 * `node:readline/promises` over stdin/stdout; tests inject a scripted fake.
 */
export interface PromptIO {
  /** Print `question`, read one line, resolve to it (raw, untrimmed). */
  ask(question: string): Promise<string>
  /** Write a line of informational output (summary, headings). */
  write(text: string): void
  /** Release the underlying stream (readline interface). */
  close(): void
}

/** Real stdin/stdout IO backed by readline/promises. */
export function createStdioPromptIO(): PromptIO {
  const rl = createInterface({ input: stdin, output: stdout })
  return {
    ask: (question) => rl.question(question),
    write: (text) => stdout.write(`${text}\n`),
    close: () => rl.close()
  }
}

/**
 * True only when it is SAFE to block on interactive prompts: stdin is a TTY AND
 * the bin is neither supervised by the Electron host nor opted out via
 * `SLAYZONE_NONINTERACTIVE=1`. Callers gate ALL prompting on this — a false
 * return means "resolve config exactly as before, no questions asked".
 */
export function canPrompt(): boolean {
  return (
    Boolean(stdin.isTTY) &&
    process.env.SLAYZONE_SUPERVISED !== '1' &&
    process.env.SLAYZONE_NONINTERACTIVE !== '1'
  )
}

/**
 * Ask a yes/no question. `[Y/n]` when `defaultYes` (Enter = yes), `[y/N]`
 * otherwise (Enter = no). Only a leading y/yes (case-insensitive) is truthy.
 */
export async function confirm(
  io: PromptIO,
  question: string,
  { defaultYes = true }: { defaultYes?: boolean } = {}
): Promise<boolean> {
  const raw = (await io.ask(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase()
  if (raw === '') return defaultYes
  return raw === 'y' || raw === 'yes'
}

/**
 * One promptable config value. The caller decides a field is MISSING (reads
 * env/config/credential-store itself) and hands only missing fields here.
 */
export interface PromptField {
  /** Key written into config.json when persisted. */
  configKey: keyof SlayzoneConfig
  /** `process.env` key seeded for THIS run so the normal resolver sees it. */
  envKey: string
  /** One-line question text (no trailing punctuation — the framer adds it). */
  label: string
  /** Applied when the user enters nothing → the field IS collected with it. */
  default?: string
  /** Extra hint shown in parens (e.g. the live hostname); NOT auto-applied. */
  hint?: string
  /**
   * Map the entered/defaulted string to its persisted + env representations
   * (e.g. a roots list → `string[]` for config, delimiter-joined for env).
   * Defaults to identity (string for both). Return `null` to drop the value.
   */
  transform?: (raw: string) => { config: unknown; env: string } | null
}

/** A field the user actually provided a value for. */
export interface CollectedField {
  field: PromptField
  config: unknown
  env: string
}

export interface RunInteractiveConfigOptions {
  /** Missing fields to prompt for, in ask order. */
  fields: PromptField[]
  /** IO override (tests). Defaults to real stdin/stdout; owned + closed here. */
  io?: PromptIO
  /** config.json path override (tests). Defaults to `<ROOT>/config.json`. */
  configPath?: string
  /** Heading printed above the write summary. */
  title?: string
}

export interface RunInteractiveConfigResult {
  /** Values the user supplied (empty ⇒ nothing to do, no confirm was shown). */
  collected: CollectedField[]
  /** Whether the collected values were persisted to config.json. */
  saved: boolean
}

/**
 * Prompt each missing field, seed the accepted values into `process.env` for
 * this run, then (if any were collected) show a summary and persist to
 * config.json on a `[Y/n]`-confirm. Declining the save keeps the values live
 * for this boot only. Callers MUST gate on {@link canPrompt} first — this
 * function does not re-check (so tests can drive it with an injected IO).
 *
 * `process.env` is seeded regardless of the save answer, so the bin's existing
 * env-first resolver consumes the values either way.
 */
export async function runInteractiveConfig(
  opts: RunInteractiveConfigOptions
): Promise<RunInteractiveConfigResult> {
  const configPath = opts.configPath ?? getSlayzoneConfigPath()
  const ownIo = opts.io === undefined
  const io = opts.io ?? createStdioPromptIO()

  try {
    const collected: CollectedField[] = []
    for (const field of opts.fields) {
      const hint = field.hint ? ` (${field.hint})` : ''
      const def = field.default !== undefined ? ` [${field.default}]` : ''
      const raw = (await io.ask(`${field.label}${hint}${def}: `)).trim()

      // Empty + no default ⇒ the user declined this field: skip (don't collect,
      // don't seed, don't persist) so downstream keeps its own default/throw.
      const value = raw === '' ? field.default : raw
      if (value === undefined || value === '') continue

      const mapped = field.transform ? field.transform(value) : { config: value, env: value }
      if (mapped === null) continue
      collected.push({ field, config: mapped.config, env: mapped.env })
    }

    if (collected.length === 0) return { collected, saved: false }

    // Seed env now so this run uses the values whether or not they're persisted.
    for (const { field, env } of collected) process.env[field.envKey] = env

    io.write('')
    io.write(opts.title ?? 'Configuration to save:')
    for (const { field, config } of collected) {
      io.write(`  ${field.configKey}: ${Array.isArray(config) ? config.join(', ') : String(config)}`)
    }
    io.write('')

    const saved = await confirm(io, `Save to ${configPath}?`, { defaultYes: true })
    if (saved) {
      const patch: Record<string, unknown> = {}
      for (const { field, config } of collected) patch[field.configKey as string] = config
      updateSlayzoneConfig(patch as Partial<SlayzoneConfig>, configPath)
      io.write(`Saved ${configPath}`)
    } else {
      io.write('Not saved — using these values for this run only.')
    }
    return { collected, saved }
  } finally {
    if (ownIo) io.close()
  }
}
