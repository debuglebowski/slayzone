/**
 * Where the AI-config ops read and write: on the computer that holds the files. A
 * project's instruction/skill/MCP files are on the project's computer (resolved from
 * the checkout path the client names, like the git panel); the computer-level ones
 * (`~/.claude`, …) on an explicit computer, else the caller's own. The hub's
 * composition wires {@link setAiConfigFsRouting}; the ops then run over a
 * computer-backed {@link AiConfigFs} (`agentConfig.fs` frames). With no computer —
 * or unwired — "connect a computer" on every hub: the hub's own disk holds neither.
 */
import type { SlayzoneDb } from '@slayzone/platform'
import { refuseNoComputer } from '@slayzone/platform/hub-switch-refusal'
import type { AiConfigDirEntry, AiConfigFs, AiConfigStat } from './ai-config-fs'
import { createAiConfigOps } from './handlers-store'

export type AiConfigOps = ReturnType<typeof createAiConfigOps>

/** One `agentConfig.fs` call; the computer answers its `result`. */
export type AiConfigFsCall =
  | { op: 'homedir' }
  | { op: 'exists' | 'readFile' | 'mkdir' | 'unlink' | 'rmdir' | 'stat' | 'readdir'; path: string }
  | { op: 'writeFile'; path: string; content: string }
  | { op: 'rename'; path: string; to: string }

export interface AiConfigFsRouting {
  /** The computer holding a project's files (by its checkout path, else its id). */
  computerForProject(target: { projectPath?: string; projectId?: string }): Promise<string | null>
  /** An explicit computer (admitted), else the caller's own. */
  computerForCaller(computerId?: string | null): Promise<string | null>
  request(computerId: string, call: AiConfigFsCall): Promise<unknown>
}

let routing: AiConfigFsRouting | null = null
/** Per computer: its fs (its home dir is asked once). */
const remoteFs = new Map<string, Promise<AiConfigFs>>()

export function setAiConfigFsRouting(next: AiConfigFsRouting | null): void {
  routing = next
  remoteFs.clear()
}

/** An {@link AiConfigFs} served by `computerId`. */
async function createRemoteAiConfigFs(
  r: AiConfigFsRouting,
  computerId: string
): Promise<AiConfigFs> {
  const home = String(await r.request(computerId, { op: 'homedir' }))
  const call = (c: AiConfigFsCall) => r.request(computerId, c)
  return {
    exists: async (path) => (await call({ op: 'exists', path })) === true,
    readFile: async (path) => String(await call({ op: 'readFile', path })),
    writeFile: async (path, content) => {
      await call({ op: 'writeFile', path, content })
    },
    mkdir: async (path) => {
      await call({ op: 'mkdir', path })
    },
    unlink: async (path) => {
      await call({ op: 'unlink', path })
    },
    rmdir: async (path) => {
      await call({ op: 'rmdir', path })
    },
    rename: async (from, to) => {
      await call({ op: 'rename', path: from, to })
    },
    stat: async (path) => (await call({ op: 'stat', path })) as AiConfigStat | null,
    readdir: async (path) => (await call({ op: 'readdir', path })) as AiConfigDirEntry[],
    homedir: () => home
  }
}

function fsFor(r: AiConfigFsRouting, computerId: string): Promise<AiConfigFs> {
  let fs = remoteFs.get(computerId)
  if (!fs) {
    fs = createRemoteAiConfigFs(r, computerId)
    // A failed first call (computer gone) must not stick.
    fs.catch(() => remoteFs.delete(computerId))
    remoteFs.set(computerId, fs)
  }
  return fs
}

/** A computer left: its home answer may change when it comes back. */
export function aiConfigComputerGone(computerId: string): void {
  remoteFs.delete(computerId)
}

async function opsOn(db: SlayzoneDb, computerId: string | null, op: string): Promise<AiConfigOps> {
  if (computerId == null || !routing) return refuseNoComputer({ op })
  return createAiConfigOps(db, await fsFor(routing, computerId))
}

/** The ops for a project's files: on the project's computer. */
export async function aiConfigOpsForProject(
  db: SlayzoneDb,
  target: { projectPath?: string; projectId?: string },
  op: string
): Promise<AiConfigOps> {
  const computerId = routing ? await routing.computerForProject(target) : null
  return opsOn(db, computerId, op)
}

/** The ops for computer-level files: an explicit computer, else the caller's own. */
export async function aiConfigOpsForComputer(
  db: SlayzoneDb,
  computerId: string | null | undefined,
  op: string
): Promise<AiConfigOps> {
  const resolved = routing ? await routing.computerForCaller(computerId) : null
  return opsOn(db, resolved, op)
}
