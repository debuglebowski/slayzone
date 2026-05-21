import { getOpencodePluginPath, writeFileIfChanged } from '@slayzone/platform'
import { toPosixPath } from './hook-paths'
// Vite resolves `?raw` to the file contents as a string at build time. Static
// import (not dynamic) so the plugin source lands in this module's chunk and
// no runtime file lookup is required in the packaged app.
// @ts-expect-error -- ?raw is a Vite runtime feature, not a typed module.
import opencodePluginSource from '@slayzone/hooks/opencode-plugin.js?raw'

const NOTIFY_PATH_PLACEHOLDER = '{{NOTIFY_PATH}}'

export interface InstallOpencodePluginOpts {
  /**
   * Absolute path to the notify script (returned by installNotifyScript).
   * Substituted into the plugin's `{{NOTIFY_PATH}}` placeholder.
   */
  notifyPath: string
  /** Override plugin source. Defaults to the bundled `opencode-plugin.js`. Tests inject a fixture. */
  source?: string
  /** Override target path. Defaults to `getOpencodePluginPath()`. */
  targetPath?: string
}

export interface InstallOpencodePluginResult {
  path: string
  changed: boolean
}

/**
 * Write the OpenCode JS plugin to `${XDG_CONFIG_HOME:-~/.config}/opencode/plugin/slayzone-notify.js`
 * with mode 0644 (loaded by OpenCode runtime as ESM; not executed directly).
 * Idempotent: re-runs are no-ops when the substituted content is unchanged.
 *
 * The `{{NOTIFY_PATH}}` placeholder in the bundled source is replaced with the
 * absolute path to `~/.slayzone/hooks/notify.sh` so the plugin can shell out
 * without env-var indirection (plugin runs inside OpenCode's process where
 * SLAYZONE_AGENT_HOOK_URL is set, but the notify path resolves at install time).
 */
export async function installOpencodePlugin(
  opts: InstallOpencodePluginOpts
): Promise<InstallOpencodePluginResult> {
  const target = opts.targetPath ?? getOpencodePluginPath()
  const rawSource =
    opts.source ??
    (typeof opencodePluginSource === 'string' ? opencodePluginSource : String(opencodePluginSource))
  // Forward-slash the path: the plugin substitutes it into a JS string literal
  // and then shells out `bash <path>` — backslashes would break both the JS
  // literal and bash's path parsing on Windows.
  const content = rawSource.split(NOTIFY_PATH_PLACEHOLDER).join(toPosixPath(opts.notifyPath))
  const changed = await writeFileIfChanged(target, content, 0o644)
  return { path: target, changed }
}
