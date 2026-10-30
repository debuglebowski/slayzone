/**
 * Test-side handle on the fake `codex app-server` (fake-codex.mjs): writes the
 * wrapper the app spawns, sets the scenario each test plays, and reads back what
 * every spawn received. README.md is the guide.
 *
 * Wiring into the app: put `binDir` in `SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR` for
 * the app launch — the computer then resolves `codex` to the fake for every spawn.
 *
 * @module test-utils/fake-codex
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createFakeCliInstall,
  FakeCliEpoch,
  FakeCliRun,
  type FakeCliInstall
} from '../fake-cli/state'
import type { CodexScenario } from './scenario'

export * from './protocol'
export * from './scenario'
export * from './transcript'
export type { FakeLogEntry } from '../fake-cli/state'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Absolute path of the fake server script. */
export const FAKE_CODEX_SCRIPT = path.join(HERE, 'fake-codex.mjs')
/** The CLI version the fake reports (= the recordings' and the protocol surface's). */
export const FAKE_CODEX_VERSION = '0.159.2'
/** Exit codes the fake uses for harness failures (never a scripted exit). */
export const FAKE_CODEX_EXIT = { argvDrift: 2, unscripted: 3 } as const

export interface CodexRpcRequest {
  id: number | string
  method: string
  params: Record<string, unknown>
}

/**
 * What one spawn of the fake saw and did. Live: every accessor re-reads the log,
 * so a run fetched early still reports what the process received since.
 */
export class FakeCodexRun extends FakeCliRun {
  /** Every JSON-RPC message the app wrote, parsed. */
  stdin(): Array<Record<string, unknown>> {
    return this.entries
      .filter((e) => e.kind === 'rpc-in')
      .map((e) => e.msg as Record<string, unknown>)
  }
  /** The app's requests, in order; one method when given. */
  requests(method?: string): CodexRpcRequest[] {
    return this.stdin()
      .filter((m) => typeof m.method === 'string' && m.id !== undefined && m.id !== null)
      .filter((m) => method === undefined || m.method === method)
      .map((m) => ({
        id: m.id as number | string,
        method: m.method as string,
        params: (m.params ?? {}) as Record<string, unknown>
      }))
  }
  /** The app's notifications (`initialized`, …). */
  notifications(): string[] {
    return this.stdin()
      .filter((m) => typeof m.method === 'string' && (m.id === undefined || m.id === null))
      .map((m) => m.method as string)
  }
  /** The text of every `turn/start` the app sent. */
  userTexts(): string[] {
    return this.requests('turn/start').map((r) =>
      ((r.params.input as Array<{ text?: string }> | undefined) ?? [])
        .map((b) => b.text ?? '')
        .join('')
    )
  }
  /** The thread this spawn serves: the one it started, or the one it resumed. */
  get threadId(): string | undefined {
    for (const line of this.stdoutLines()) {
      const msg = JSON.parse(line) as { result?: { thread?: { id?: string } } }
      if (msg.result?.thread?.id) return msg.result.thread.id
    }
    return undefined
  }
  /** `thread/resume`'s thread id, when this spawn resumed one. */
  get resumedThread(): string | undefined {
    return this.requests('thread/resume')[0]?.params.threadId as string | undefined
  }
  /** `turn/interrupt` requests: the turn id the app named (null = none) and the turn running then. */
  interrupts(): Array<{ turnId: string | null; current: string | null }> {
    return this.entries
      .filter((e) => e.kind === 'interrupt')
      .map((e) => ({ turnId: e.turnId as string | null, current: e.current as string | null }))
  }
  /** Ids of the turns the fake ran, in order. */
  turnIds(): string[] {
    return this.entries.filter((e) => e.kind === 'turn').map((e) => e.turnId as string)
  }
  /** `clientUserMessageId` of every `turn/start` (null when the app sent none). */
  clientMessageIds(): Array<string | null> {
    return this.requests('turn/start').map(
      (r) => (r.params.clientUserMessageId as string | undefined) ?? null
    )
  }
  /** `thread/revert` calls the fake carried out: the turn reverted from and how many went. */
  reverts(): Array<{ threadId: string; beforeTurnId: string; dropped: number }> {
    return this.entries
      .filter((e) => e.kind === 'revert')
      .map((e) => ({
        threadId: e.threadId as string,
        beforeTurnId: e.beforeTurnId as string,
        dropped: e.dropped as number
      }))
  }
  /** `thread/fork` calls: the source thread, the new one, how many turns it kept. */
  forks(): Array<{ from: string; threadId: string; kept: number }> {
    return this.entries
      .filter((e) => e.kind === 'fork')
      .map((e) => ({
        from: e.from as string,
        threadId: e.threadId as string,
        kept: e.kept as number
      }))
  }
  /** `thread/compact/start` calls. */
  compactions(): number {
    return this.entries.filter((e) => e.kind === 'compact').length
  }
  /** Turns the fake aborted because of an interrupt. */
  interruptedTurns(): string[] {
    return this.entries.filter((e) => e.kind === 'turn-interrupted').map((e) => e.turnId as string)
  }
  /** Server→client requests the fake sent. */
  serverRequests(): Array<{ requestId: number; method: string; params: unknown }> {
    return this.entries
      .filter((e) => e.kind === 'request')
      .map((e) => ({
        requestId: e.requestId as number,
        method: e.method as string,
        params: e.params
      }))
  }
  /** The app's replies to them: `decision` = `accept`, `acceptForSession`, `decline`, … or `error`. */
  requestReplies(): Array<{ requestId: number; method: string; decision: string; reply: unknown }> {
    return this.entries
      .filter((e) => e.kind === 'request-reply')
      .map((e) => ({
        requestId: e.requestId as number,
        method: e.method as string,
        decision: e.decision as string,
        reply: e.reply
      }))
  }
  /** Requests an interrupt left unanswered. */
  abandonedRequests(): number[] {
    return this.entries
      .filter((e) => e.kind === 'request-abandoned')
      .map((e) => e.requestId as number)
  }
  /** Replies to a request no longer pending (abandoned, or answered twice). */
  lateReplies(): Array<{ requestId: unknown }> {
    return this.entries
      .filter((e) => e.kind === 'late-reply')
      .map((e) => ({ requestId: e.requestId }))
  }
  /** Client methods the fake does not implement (answered -32601). */
  unknownMethods(): string[] {
    return this.entries.filter((e) => e.kind === 'unknown-method').map((e) => e.method as string)
  }
  /** Replayed requests answered differently from the recording. */
  replayMismatches(): Array<{ requestId: unknown; recorded: string; got: string }> {
    return this.entries
      .filter((e) => e.kind === 'replay-mismatch')
      .map((e) => ({
        requestId: e.requestId,
        recorded: e.recorded as string,
        got: e.got as string
      }))
  }
  /** Methods of the notifications the fake wrote, in order. */
  sentMethods(): string[] {
    return this.stdoutLines()
      .map((l) => {
        try {
          return (JSON.parse(l) as { method?: string }).method
        } catch {
          return undefined
        }
      })
      .filter((m): m is string => typeof m === 'string')
  }
}

/** One scenario's worth of spawns. */
export class FakeCodexEpoch extends FakeCliEpoch<FakeCodexRun> {
  constructor(dir: string) {
    super(dir, (index, logFile) => new FakeCodexRun(index, logFile), 'fake-codex')
  }
}

export type FakeCodex = FakeCliInstall<CodexScenario, FakeCodexEpoch>

/**
 * Create a fake-codex install under `root` (created; must not be shared between
 * concurrent apps). `nodePath` runs the script; it defaults to this process's own
 * binary — Electron included, the wrapper sets ELECTRON_RUN_AS_NODE.
 */
export function createFakeCodex(opts: { root: string; nodePath?: string }): FakeCodex {
  return createFakeCliInstall({
    ...opts,
    binName: 'codex',
    script: FAKE_CODEX_SCRIPT,
    stateEnvVar: 'FAKE_CODEX_STATE_DIR',
    label: 'fake-codex',
    makeEpoch: (dir) => new FakeCodexEpoch(dir)
  })
}
