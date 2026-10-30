// Process-side core shared by the scripted fake CLIs (fake-claude, fake-codex):
// claim this spawn's script from the epoch the test set, append to its log, and a
// few helpers every fake needs. Zero dependencies, plain ESM, like the fakes.
//
// State dir layout (written by the test side, state.ts):
//   <state>/current                       id of the epoch spawns play now
//   <state>/epochs/<id>/scenario.json     what each spawn plays
//   <state>/epochs/<id>/procs/<i>/        claimed by the i-th spawn (mkdir = atomic)
//   <state>/epochs/<id>/procs/<i>/log.jsonl
//   <state>/unscripted.jsonl              spawns that found no epoch at all

import fs from 'node:fs'
import path from 'node:path'

/** Exit code of a spawn that found no state dir or no epoch (harness failure). */
export const EXIT_UNSCRIPTED = 3

/** Thrown into a running script when its turn is aborted (interrupt). */
export class Aborted extends Error {}

/**
 * Claim this spawn's slot. `stateEnvVar` names the env var the wrapper bakes the
 * state dir into; `label` prefixes stderr. Exits 3 when the var is missing.
 */
export function claimSpawn({ stateEnvVar, label }) {
  const t0 = Date.now()
  const stateDir = process.env[stateEnvVar]
  if (!stateDir) {
    process.stderr.write(`${label}: ${stateEnvVar} is not set (run it through its wrapper)\n`)
    process.exit(EXIT_UNSCRIPTED)
  }
  const epoch = readCurrentEpoch(stateDir)
  const epochDir = epoch ? path.join(stateDir, 'epochs', epoch) : null
  const scenario = epochDir
    ? JSON.parse(fs.readFileSync(path.join(epochDir, 'scenario.json'), 'utf8'))
    : null
  const index = epochDir ? claimIndex(epochDir) : -1
  const logFile = epochDir
    ? path.join(epochDir, 'procs', String(index), 'log.jsonl')
    : path.join(stateDir, 'unscripted.jsonl')

  function log(kind, data) {
    try {
      fs.appendFileSync(logFile, `${JSON.stringify({ t: Date.now() - t0, kind, ...data })}\n`)
    } catch {
      // The state dir is gone (test torn down) — nothing left to record into.
    }
  }

  /** Earlier spawns of this epoch whose process is still alive (by their logged pid). */
  function peersAlive() {
    if (!epochDir) return []
    const alive = []
    for (let i = 0; i < index; i++) {
      let pid
      try {
        const first = fs
          .readFileSync(path.join(epochDir, 'procs', String(i), 'log.jsonl'), 'utf8')
          .split('\n')
          .find((l) => l.includes('"kind":"start"'))
        pid = first ? JSON.parse(first).pid : undefined
      } catch {
        continue
      }
      if (typeof pid !== 'number') continue
      try {
        process.kill(pid, 0)
        alive.push(i)
      } catch {
        // gone
      }
    }
    return alive
  }

  /** The i-th process script; `repeatLast` reuses the last one for later spawns. */
  const script =
    scenario?.processes?.[index] ??
    (scenario?.repeatLast && scenario.processes?.length ? scenario.processes.at(-1) : undefined)

  return { t0, stateDir, epoch, epochDir, scenario, index, logFile, script, log, peersAlive }
}

/** Resolve after `ms`; an aborted `signal` rejects with `Aborted`. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Aborted())
    })
  })
}

/** Call `onLine` for every non-blank newline-terminated line of `stream`. */
export function readLines(stream, onLine, onEnd) {
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buf += chunk
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim()) onLine(line)
      nl = buf.indexOf('\n')
    }
  })
  if (onEnd) stream.on('end', onEnd)
}

function readCurrentEpoch(stateDir) {
  try {
    return fs.readFileSync(path.join(stateDir, 'current'), 'utf8').trim() || null
  } catch {
    return null
  }
}

/** The lowest unclaimed spawn index of this epoch. mkdir is atomic: one winner each. */
function claimIndex(dir) {
  fs.mkdirSync(path.join(dir, 'procs'), { recursive: true })
  for (let i = 0; ; i++) {
    try {
      fs.mkdirSync(path.join(dir, 'procs', String(i)))
      return i
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
    }
  }
}
