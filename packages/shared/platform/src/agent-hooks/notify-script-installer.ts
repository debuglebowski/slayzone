import path from 'path'
import { getHooksDir } from '../dirs'
import { updateFileAtomically } from '../fs-utils'

export interface InstallNotifyScriptOpts {
  /**
   * The `notify.sh` body to install. REQUIRED, and deliberately not defaulted
   * here: the content is inlined by the CALLER's bundler (the desktop app via
   * Vite `?raw`, the standalone runner via esbuild's `text` loader), so this
   * module stays free of any bundler-specific import syntax and can be shared by
   * both. A runtime file read is not an option — `@slayzone/hooks` is private
   * and never published, and the runner ships as one self-contained bundle.
   */
  source: string
  /** Override target path. Defaults to `~/.slayzone/hooks/notify.sh`. */
  targetPath?: string
}

/**
 * Parse the `SLAYZONE_NOTIFY_VERSION=N` marker from a notify-script body.
 * The marker is a shell comment (`# SLAYZONE_NOTIFY_VERSION=3`) so it is inert
 * when the script runs. Absent/malformed → 0: a legacy unversioned script
 * (the real clobber victim) is the oldest possible, so any versioned script
 * upgrades it.
 */
export function parseNotifyVersion(script: string): number {
  const m = /SLAYZONE_NOTIFY_VERSION=(\d+)/.exec(script)
  if (!m) return 0
  const n = Number.parseInt(m[1]!, 10)
  return Number.isFinite(n) ? n : 0
}

/**
 * Write the agent lifecycle notify script to `~/.slayzone/hooks/notify.sh`
 * with mode 0755.
 *
 * VERSION GATE — the prod and dev release channels share ONE on-disk
 * notify.sh (the path is `~/.slayzone/hooks/notify.sh` for both, since
 * `getSlayzoneHomeDir()` is not release-channel-scoped). The script is
 * backward-compatible (an older server ignores newer envelope fields like
 * `slaySessionId`), so a NEWER script is always safe for an OLDER app to run —
 * but an OLDER app must never DOWNGRADE a newer script. That downgrade is what
 * stripped `slaySessionId`, making warm-pool sessions invisible (no task
 * resolution → no running-spinner, no unread flag).
 *
 * So: write only when the incoming version is >= the on-disk version. Highest
 * version wins regardless of release channel or boot order. Below equality it still
 * gets byte-level idempotency (equal-version content tweaks in dev still land; a
 * genuine no-op stays a no-op).
 *
 * The gate runs INSIDE `updateFileAtomically`'s merge, which is what makes it
 * sound. A gate is only as good as the read it judges: comparing versions, then
 * writing in a separate step, decides "mine is newer" against a snapshot a peer
 * may already have replaced — so the downgrade this function exists to prevent
 * could still happen through the gap. Now the comparison and the replacement are
 * one guarded cycle, and a peer that commits first forces the gate to be
 * re-evaluated against what is actually on disk. This matters more than it used
 * to: the desktop app is no longer the only installer — a standalone runner
 * installs the same shared script on the same machine.
 *
 * Returns the absolute target path so the agent hook installers can wire it.
 */
export async function installNotifyScript(
  opts: InstallNotifyScriptOpts
): Promise<{ path: string; changed: boolean }> {
  const target = opts.targetPath ?? path.join(getHooksDir(), 'notify.sh')
  const source = opts.source
  const incomingV = parseNotifyVersion(source)

  const changed = await updateFileAtomically(
    target,
    (current) => {
      if (current === null) return source
      // Strict downgrade → decline: preserve the newer on-disk script untouched.
      if (incomingV < parseNotifyVersion(current.toString('utf8'))) return null
      return source
    },
    { mode: 0o755 }
  )
  return { path: target, changed }
}
