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
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Scenario } from './scenario'

export * from './scenario'
export * from './transcript'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Absolute path of the fake CLI script. */
export const FAKE_CLAUDE_SCRIPT = path.join(HERE, 'fake-claude.mjs')
/** Exit codes the fake uses for harness failures (never a scripted exit). */
export const FAKE_CLAUDE_EXIT = { argvDrift: 2, unscripted: 3 } as const

/** One line of a spawn's log.jsonl. `t` = ms since that spawn started. */
export type FakeLogEntry = { t: number; kind: string } & Record<string, unknown>

/**
 * What one spawn of the fake saw and did. Live: every accessor re-reads the log,
 * so a run fetched early still reports what the process received since.
 */
export class FakeRun {
  constructor(
    readonly index: number,
    private readonly logFile: string
  ) {}

  get entries(): FakeLogEntry[] {
    return readLog(this.logFile)
  }

  private start(): FakeLogEntry {
    const start = this.entries.find((e) => e.kind === 'start')
    if (!start) throw new Error(`fake run #${this.index} has no start entry`)
    return start
  }
  get argv(): string[] {
    return this.start().argv as string[]
  }
  get cwd(): string {
    return this.start().cwd as string
  }
  get pid(): number {
    return this.start().pid as number
  }
  /** `--resume <id>` spawn (vs `--session-id <id>`). */
  get resumed(): boolean {
    return this.argv.includes('--resume')
  }
  get sessionId(): string | undefined {
    const at = this.argv.findIndex((a) => a === '--resume' || a === '--session-id')
    return at >= 0 ? this.argv[at + 1] : undefined
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
  /** The app's control requests (`interrupt`, `set_model`, …), in order. */
  controlRequests(): Array<Record<string, unknown>> {
    return this.stdin()
      .filter((m) => m.type === 'control_request')
      .map((m) => m.request as Record<string, unknown>)
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
  stdoutLines(): string[] {
    return this.entries.filter((e) => e.kind === 'stdout').map((e) => e.line as string)
  }
  signals(): string[] {
    return this.entries.filter((e) => e.kind === 'signal').map((e) => e.signal as string)
  }
  /** The exit the fake recorded itself (absent after SIGKILL or while running). */
  exit(): { code?: number; signal?: string } | undefined {
    const e = this.entries.find((x) => x.kind === 'exit')
    return e
      ? { code: e.code as number | undefined, signal: e.signal as string | undefined }
      : undefined
  }
  has(kind: string): boolean {
    return this.entries.some((e) => e.kind === kind)
  }
}

/** One scenario's worth of spawns. */
export class FakeEpoch {
  constructor(readonly dir: string) {}

  runs(): FakeRun[] {
    const procs = path.join(this.dir, 'procs')
    if (!fs.existsSync(procs)) return []
    return fs
      .readdirSync(procs)
      .map(Number)
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => a - b)
      .map((i) => new FakeRun(i, path.join(procs, String(i), 'log.jsonl')))
  }

  run(index: number): FakeRun | undefined {
    return this.runs().find((r) => r.index === index)
  }

  /** Spawns past the scenario's scripts (the fake exited 3 on each). */
  unscripted(): FakeRun[] {
    return this.runs().filter((r) => r.has('unscripted'))
  }

  /** Spawns that died of adapter argv drift (the fake exited 2). */
  argvDrift(): FakeRun[] {
    return this.runs().filter((r) => r.has('argv-drift'))
  }

  /** Poll until `pred` holds for the run at `index`; returns that run. */
  async waitForRun(
    index: number,
    pred: (run: FakeRun) => boolean = () => true,
    timeoutMs = 15_000
  ): Promise<FakeRun> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const run = this.run(index)
      if (run && run.entries.length > 0 && pred(run)) return run
      if (Date.now() > deadline) {
        throw new Error(
          `fake-claude: run #${index} did not reach the expected state within ${timeoutMs}ms ` +
            `(runs so far: ${this.runs().length}; last entries: ${JSON.stringify(run?.entries.slice(-5) ?? [])})`
        )
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}

export interface FakeClaude {
  /** Holds the `claude` wrapper. Point `SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR` here. */
  readonly binDir: string
  readonly stateDir: string
  /** Start a new epoch: every later spawn plays `scenario`. */
  setScenario(scenario: Scenario): FakeEpoch
  /** The epoch set last (throws before the first `setScenario`). */
  current(): FakeEpoch
  /** Spawns that found no scenario at all (none set yet). */
  orphans(): FakeLogEntry[]
  dispose(): void
}

/**
 * Create a fake-claude install under `root` (created; must not be shared between
 * concurrent apps). `nodePath` runs the script; it defaults to this process's own
 * binary — Electron included, the wrapper sets ELECTRON_RUN_AS_NODE.
 */
export function createFakeClaude(opts: { root: string; nodePath?: string }): FakeClaude {
  const binDir = path.join(opts.root, 'bin')
  const stateDir = path.join(opts.root, 'state')
  fs.mkdirSync(binDir, { recursive: true })
  fs.mkdirSync(path.join(stateDir, 'epochs'), { recursive: true })
  const nodePath = opts.nodePath ?? process.execPath
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  fs.writeFileSync(
    path.join(binDir, 'claude'),
    [
      '#!/bin/sh',
      '# Generated by @slayzone/test-utils/fake-claude: a scripted stand-in for `claude`.',
      `FAKE_CLAUDE_STATE_DIR=${q(stateDir)}`,
      'export FAKE_CLAUDE_STATE_DIR',
      'ELECTRON_RUN_AS_NODE=1',
      'export ELECTRON_RUN_AS_NODE',
      `exec ${q(nodePath)} ${q(FAKE_CLAUDE_SCRIPT)} "$@"`,
      ''
    ].join('\n'),
    { mode: 0o755 }
  )

  let epochSeq = 0
  let current: FakeEpoch | undefined
  return {
    binDir,
    stateDir,
    setScenario(scenario) {
      epochSeq += 1
      const id = `${epochSeq}-${Date.now()}`
      const dir = path.join(stateDir, 'epochs', id)
      fs.mkdirSync(path.join(dir, 'procs'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(scenario, null, 2))
      // Atomic switch: a spawn reads either the old epoch or the new one, never half.
      const tmp = path.join(stateDir, `current.${process.pid}.tmp`)
      fs.writeFileSync(tmp, id)
      fs.renameSync(tmp, path.join(stateDir, 'current'))
      current = new FakeEpoch(dir)
      return current
    },
    current() {
      if (!current) throw new Error('fake-claude: no scenario set yet')
      return current
    },
    orphans() {
      return readLog(path.join(stateDir, 'unscripted.jsonl'))
    },
    dispose() {
      fs.rmSync(opts.root, { recursive: true, force: true })
    }
  }
}

function readLog(file: string): FakeLogEntry[] {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: FakeLogEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as FakeLogEntry)
    } catch {
      // A line being appended right now — the next read gets it whole.
    }
  }
  return out
}
