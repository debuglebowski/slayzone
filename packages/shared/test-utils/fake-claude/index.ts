/**
 * Test-side handle on the fake `claude` CLI (fake-claude.mjs): writes the wrapper
 * the app spawns, sets the scenario each test plays, and reads back what every
 * spawn received. README.md is the guide.
 *
 * Wiring into the app: put `binDir` in `SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR` for
 * the app launch — the computer then resolves `claude` to the fake for every
 * spawn (a dir merely prepended to PATH loses to the login-shell PATH).
 *
 * @module test-utils/fake-claude
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createFakeCliInstall,
  FakeCliEpoch,
  FakeCliRun,
  type FakeCliInstall
} from '../fake-cli/state'
import type { Scenario } from './scenario'

export type { FakeLogEntry } from '../fake-cli/state'

export * from './scenario'
export * from './stream'
export * from './tasks'
export * from './session-file'
export * from './transcript'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Absolute path of the fake CLI script. */
export const FAKE_CLAUDE_SCRIPT = path.join(HERE, 'fake-claude.mjs')
/** Exit codes the fake uses for harness failures (never a scripted exit). */
export const FAKE_CLAUDE_EXIT = { argvDrift: 2, unscripted: 3 } as const

/**
 * What one spawn of the fake saw and did. Live: every accessor re-reads the log,
 * so a run fetched early still reports what the process received since.
 */
export class FakeRun extends FakeCliRun {
  /** `--resume <id>` spawn (vs `--session-id <id>`). */
  get resumed(): boolean {
    return this.argv.includes('--resume')
  }
  get sessionId(): string | undefined {
    const at = this.argv.findIndex((a) => a === '--resume' || a === '--session-id')
    return at >= 0 ? this.argv[at + 1] : undefined
  }
  /** `--resume S --fork-session`: a new conversation holding S's history. */
  get forked(): boolean {
    return this.argv.includes('--fork-session')
  }
  /** Spawned as the interactive TUI (a `tui: true` script). */
  get tui(): boolean {
    return this.start().tui === true
  }
  /** The env keys the fake records (`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`, `CLAUDE_CONFIG_DIR`). */
  get env(): Record<string, string> {
    return (this.start().env as Record<string, string> | undefined) ?? {}
  }
  /** Targets of `rewind_conversation` requests that found their message. */
  rewound(): string[] {
    return this.entries.filter((e) => e.kind === 'rewound').map((e) => e.target as string)
  }
  /** User message uuids the conversation received a second time. */
  duplicateUserUuids(): string[] {
    return this.entries.filter((e) => e.kind === 'duplicate-user-uuid').map((e) => e.uuid as string)
  }
  flag(name: string): string | undefined {
    const at = this.argv.indexOf(name)
    return at >= 0 ? this.argv[at + 1] : undefined
  }
  /** Every message the app wrote to stdin, parsed. */
  stdin(): Array<Record<string, unknown>> {
    return this.entries
      .filter((e) => e.kind === 'stdin')
      .map((e) => e.msg as Record<string, unknown>)
  }
  /** Texts of the user messages (not tool results) the app sent. */
  userMessages(): string[] {
    return this.stdin()
      .filter((m) => m.type === 'user')
      .map((m) => (m.message as { content?: unknown } | undefined)?.content)
      .filter((c): c is string => typeof c === 'string')
  }
  /**
   * The content of every user message the app sent (not tool results), as
   * written: a string, or the block array (attachments, `/command` + files).
   */
  userContents(): Array<string | Array<Record<string, unknown>>> {
    return this.stdin()
      .filter((m) => m.type === 'user')
      .map((m) => (m.message as { content?: unknown } | undefined)?.content)
      .filter(
        (c): c is string | Array<Record<string, unknown>> =>
          typeof c === 'string' ||
          (Array.isArray(c) && (c[0] as { type?: string } | undefined)?.type !== 'tool_result')
      )
  }
  /**
   * The app's control requests (`interrupt`, `set_model`, …), in order; one
   * subtype when given. Without one, the `initialize` the Claude driver writes
   * at every spawn is left out (session setup, not something the conversation
   * did); `controlRequests('initialize')` has it.
   */
  controlRequests(subtype?: string): Array<Record<string, unknown>> {
    return this.stdin()
      .filter((m) => m.type === 'control_request')
      .map((m) => m.request as Record<string, unknown>)
      .filter((r) => (subtype === undefined ? r.subtype !== 'initialize' : r.subtype === subtype))
  }
  /** The app's decisions on `can_use_tool` requests the fake made. */
  decisions(): Array<{ requestId: string; toolName: string; behavior: string; reply: unknown }> {
    return this.entries
      .filter((e) => e.kind === 'decision')
      .map((e) => ({
        requestId: e.requestId as string,
        toolName: e.toolName as string,
        behavior: e.behavior as string,
        reply: e.reply
      }))
  }
  /** Replies to `hostRequest` steps (or `timeout`), in order. */
  hostReplies(): Array<{ requestId: string; subtype: string; reply: unknown }> {
    return this.entries
      .filter((e) => e.kind === 'host-reply')
      .map((e) => ({
        requestId: e.requestId as string,
        subtype: e.subtype as string,
        reply: e.reply
      }))
  }
  /** Request ids the fake withdrew (`control_cancel_request`). */
  cancels(): string[] {
    return this.entries.filter((e) => e.kind === 'cancel').map((e) => e.requestId as string)
  }
  /** Answers that arrived for a request no longer pending (cancelled, or answered twice). */
  lateAnswers(): string[] {
    return this.entries.filter((e) => e.kind === 'late-answer').map((e) => e.requestId as string)
  }
  /** Replayed requests answered with a different behavior than the recording. */
  replayMismatches(): Array<{ requestId: string; recorded: string; got: string }> {
    return this.entries
      .filter((e) => e.kind === 'replay-mismatch')
      .map((e) => ({
        requestId: e.requestId as string,
        recorded: e.recorded as string,
        got: e.got as string
      }))
  }
}

/** One scenario's worth of spawns. */
export class FakeEpoch extends FakeCliEpoch<FakeRun> {
  constructor(dir: string) {
    super(dir, (index, logFile) => new FakeRun(index, logFile), 'fake-claude')
  }
}

export type FakeClaude = FakeCliInstall<Scenario, FakeEpoch>

/**
 * Create a fake-claude install under `root` (created; must not be shared between
 * concurrent apps). `nodePath` runs the script; it defaults to this process's own
 * binary — Electron included, the wrapper sets ELECTRON_RUN_AS_NODE.
 */
export function createFakeClaude(opts: { root: string; nodePath?: string }): FakeClaude {
  return createFakeCliInstall({
    ...opts,
    binName: 'claude',
    script: FAKE_CLAUDE_SCRIPT,
    stateEnvVar: 'FAKE_CLAUDE_STATE_DIR',
    label: 'fake-claude',
    makeEpoch: (dir) => new FakeEpoch(dir)
  })
}
