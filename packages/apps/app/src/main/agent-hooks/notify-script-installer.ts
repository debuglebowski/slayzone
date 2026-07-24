import fs from 'fs/promises'
import path from 'path'
import { getSlayzoneHomeDir, writeFileIfChanged } from '@slayzone/platform'
// Vite resolves `?raw` to the file contents as a string at build time. Static
// import (not dynamic) so the script content lands in this module's chunk and
// no runtime file lookup is required in the packaged app.
// @ts-expect-error -- ?raw is a Vite runtime feature, not a typed module.
import notifyScriptSource from '@slayzone/hooks/notify.sh?raw'

export interface InstallNotifyScriptOpts {
  /** Override script source. Defaults to the bundled `notify.sh`. Tests inject a fixture. */
  source?: string
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

async function readExisting(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, 'utf8')
  } catch (err: unknown) {
    if (typeof err === 'object' && err != null && (err as { code?: string }).code === 'ENOENT') {
      return null
    }
    throw err
  }
}

/**
 * Write the agent lifecycle notify script to `~/.slayzone/hooks/notify.sh`
 * with mode 0755.
 *
 * VERSION GATE — the prod and dev SlayZone channels share ONE on-disk
 * notify.sh (the path is `~/.slayzone/hooks/notify.sh` for both, since
 * `getSlayzoneHomeDir()` is not channel-scoped). The script is
 * backward-compatible (an older server ignores newer envelope fields like
 * `slaySessionId`), so a NEWER script is always safe for an OLDER app to run —
 * but an OLDER app must never DOWNGRADE a newer script. That downgrade is what
 * stripped `slaySessionId`, making warm-pool sessions invisible (no task
 * resolution → no running-spinner, no unread flag).
 *
 * So: write only when the incoming version is >= the on-disk version. Highest
 * version wins regardless of channel or boot order. Below equality it still
 * defers to `writeFileIfChanged` for byte-level idempotency (equal-version
 * content tweaks in dev still land; a genuine no-op stays a no-op).
 *
 * Returns the absolute target path so the agent hook installers can wire it.
 */
export async function installNotifyScript(
  opts: InstallNotifyScriptOpts = {}
): Promise<{ path: string; changed: boolean }> {
  const target = opts.targetPath ?? path.join(getSlayzoneHomeDir(), 'hooks', 'notify.sh')
  const source =
    opts.source ??
    (typeof notifyScriptSource === 'string' ? notifyScriptSource : String(notifyScriptSource))

  const existing = await readExisting(target)
  if (existing !== null) {
    const incomingV = parseNotifyVersion(source)
    const existingV = parseNotifyVersion(existing)
    // Strict downgrade → refuse: preserve the newer on-disk script untouched.
    if (incomingV < existingV) return { path: target, changed: false }
  }

  const changed = await writeFileIfChanged(target, source, 0o755)
  return { path: target, changed }
}
