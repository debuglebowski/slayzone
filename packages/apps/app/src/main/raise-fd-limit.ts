// Raise RLIMIT_NOFILE for the Electron main process as early as possible so
// every child process (PTY shells, ripgrep, git, renderer helpers) inherits a
// high soft limit.
//
// macOS default is 256 (`launchctl limit maxfiles`), which is too low for
// Bun-compiled CLIs (e.g. Factory.ai droid) and for tools like ripgrep that
// open many files concurrently on large repos. The hard limit is typically
// `unlimited`, so bumping the soft limit requires no elevated privileges.
//
// Best-effort: if the native addon fails to load (platform mismatch, missing
// rebuild) or setrlimit errors, we log and continue — the per-PTY sh wrapper
// in shell-env.ts still provides protection for terminal sessions.

export const FD_LIMIT_TARGET_SOFT = 65535

interface RlimitPair {
  soft: number | null
  hard: number | null
}
export interface PosixModule {
  getrlimit: (resource: string) => RlimitPair
  setrlimit: (resource: string, limits: { soft?: number | null; hard?: number | null }) => void
}

export interface FdLimitResult {
  ok: boolean
  soft: number | string
  hard: number | string
  raised: boolean
  reason?: string
}

// posix returns null soft/hard to mean "unlimited"; treat that as infinity.
const asNumber = (v: number | null): number => (v === null ? Number.MAX_SAFE_INTEGER : v)

/**
 * Pure logic — exported for unit testing. Takes an injectable posix loader
 * so tests can drive the branch table without needing the native addon.
 */
export function raiseFdLimitWith(
  loadPosix: () => PosixModule,
  platform: NodeJS.Platform = process.platform
): FdLimitResult {
  if (platform === 'win32') {
    return { ok: true, soft: 'n/a', hard: 'n/a', raised: false, reason: 'windows-unsupported' }
  }

  let posix: PosixModule
  try {
    posix = loadPosix()
  } catch (err) {
    return {
      ok: false,
      soft: -1,
      hard: -1,
      raised: false,
      reason: `load-failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  try {
    const before = posix.getrlimit('nofile')
    if (asNumber(before.soft) >= FD_LIMIT_TARGET_SOFT) {
      return {
        ok: true,
        soft: before.soft ?? 'unlimited',
        hard: before.hard ?? 'unlimited',
        raised: false,
        reason: 'already-high'
      }
    }
    posix.setrlimit('nofile', { soft: FD_LIMIT_TARGET_SOFT, hard: before.hard })
    const after = posix.getrlimit('nofile')
    return {
      ok: true,
      soft: after.soft ?? 'unlimited',
      hard: after.hard ?? 'unlimited',
      raised: true
    }
  } catch (err) {
    return {
      ok: false,
      soft: -1,
      hard: -1,
      raised: false,
      reason: `setrlimit-failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

export function raiseFdLimit(): FdLimitResult {
  return raiseFdLimitWith(() => require('posix') as PosixModule)
}
