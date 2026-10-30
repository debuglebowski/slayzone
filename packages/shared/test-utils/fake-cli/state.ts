/**
 * Test-side core shared by the scripted fake CLIs (fake-claude, fake-codex): the
 * generated wrapper the app spawns, scenario epochs, and readers for each spawn's
 * log. The process side is runtime.mjs (same state dir layout, documented there).
 *
 * @module test-utils/fake-cli/state
 */
import fs from 'node:fs'
import path from 'node:path'

/** One line of a spawn's log.jsonl. `t` = ms since that spawn started. */
export type FakeLogEntry = { t: number; kind: string } & Record<string, unknown>

/**
 * What one spawn of a fake saw and did, as far as every fake logs it. Live: every
 * accessor re-reads the log, so a run fetched early still reports what arrived since.
 */
export class FakeCliRun {
  constructor(
    readonly index: number,
    protected readonly logFile: string
  ) {}

  get entries(): FakeLogEntry[] {
    return readLog(this.logFile)
  }

  protected start(): FakeLogEntry {
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
  /** Wall-clock ms when this spawn started. */
  get startedAt(): number {
    return this.start().at as number
  }
  /** Indexes of earlier spawns of the epoch that were still alive when this one started. */
  get peersAliveAtStart(): number[] {
    return (this.start().peersAlive as number[] | undefined) ?? []
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
export class FakeCliEpoch<R extends FakeCliRun> {
  constructor(
    readonly dir: string,
    private readonly makeRun: (index: number, logFile: string) => R,
    private readonly label: string
  ) {}

  runs(): R[] {
    const procs = path.join(this.dir, 'procs')
    if (!fs.existsSync(procs)) return []
    return fs
      .readdirSync(procs)
      .map(Number)
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => a - b)
      .map((i) => this.makeRun(i, path.join(procs, String(i), 'log.jsonl')))
  }

  run(index: number): R | undefined {
    return this.runs().find((r) => r.index === index)
  }

  /** Spawns past the scenario's scripts (the fake exited 3 on each). */
  unscripted(): R[] {
    return this.runs().filter((r) => r.has('unscripted'))
  }

  /** Spawns that died of adapter argv drift (the fake exited 2). */
  argvDrift(): R[] {
    return this.runs().filter((r) => r.has('argv-drift'))
  }

  /** Poll until `pred` holds for the run at `index`; returns that run. */
  async waitForRun(
    index: number,
    pred: (run: R) => boolean = () => true,
    timeoutMs = 15_000
  ): Promise<R> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const run = this.run(index)
      if (run && run.entries.length > 0 && pred(run)) return run
      if (Date.now() > deadline) {
        throw new Error(
          `${this.label}: run #${index} did not reach the expected state within ${timeoutMs}ms ` +
            `(runs so far: ${this.runs().length}; last entries: ${JSON.stringify(run?.entries.slice(-5) ?? [])})`
        )
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}

export interface FakeCliInstall<S, E> {
  /** Holds the wrapper. Point `SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR` here. */
  readonly binDir: string
  readonly stateDir: string
  /** Start a new epoch: every later spawn plays `scenario`. */
  setScenario(scenario: S): E
  /** The epoch set last (throws before the first `setScenario`). */
  current(): E
  /** Spawns that found no scenario at all (none set yet). */
  orphans(): FakeLogEntry[]
  dispose(): void
}

/**
 * Create a fake CLI install under `root` (created; must not be shared between
 * concurrent apps): `bin/<binName>` execs `script` with `nodePath` (default: this
 * process's own binary — Electron included, the wrapper sets ELECTRON_RUN_AS_NODE)
 * and bakes the state dir into `stateEnvVar`.
 */
export function createFakeCliInstall<S, E>(opts: {
  root: string
  binName: string
  script: string
  stateEnvVar: string
  label: string
  nodePath?: string
  makeEpoch: (dir: string) => E
}): FakeCliInstall<S, E> {
  const binDir = path.join(opts.root, 'bin')
  const stateDir = path.join(opts.root, 'state')
  fs.mkdirSync(binDir, { recursive: true })
  fs.mkdirSync(path.join(stateDir, 'epochs'), { recursive: true })
  const nodePath = opts.nodePath ?? process.execPath
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  fs.writeFileSync(
    path.join(binDir, opts.binName),
    [
      '#!/bin/sh',
      `# Generated by @slayzone/test-utils/${opts.label}: a scripted stand-in for \`${opts.binName}\`.`,
      `${opts.stateEnvVar}=${q(stateDir)}`,
      `export ${opts.stateEnvVar}`,
      'ELECTRON_RUN_AS_NODE=1',
      'export ELECTRON_RUN_AS_NODE',
      `exec ${q(nodePath)} ${q(opts.script)} "$@"`,
      ''
    ].join('\n'),
    { mode: 0o755 }
  )

  let epochSeq = 0
  let current: E | undefined
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
      current = opts.makeEpoch(dir)
      return current
    },
    current() {
      if (!current) throw new Error(`${opts.label}: no scenario set yet`)
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

export function readLog(file: string): FakeLogEntry[] {
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
