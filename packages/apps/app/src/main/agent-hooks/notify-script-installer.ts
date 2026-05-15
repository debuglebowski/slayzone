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
 * Write the agent lifecycle notify script to `~/.slayzone/hooks/notify.sh`
 * with mode 0755. Idempotent: re-runs are no-ops when content is unchanged.
 * Returns the absolute target path so the Claude hook installer can wire it.
 */
export async function installNotifyScript(
  opts: InstallNotifyScriptOpts = {},
): Promise<{ path: string; changed: boolean }> {
  const target = opts.targetPath ?? path.join(getSlayzoneHomeDir(), 'hooks', 'notify.sh')
  const source = opts.source ?? (typeof notifyScriptSource === 'string' ? notifyScriptSource : String(notifyScriptSource))
  const changed = await writeFileIfChanged(target, source, 0o755)
  return { path: target, changed }
}
