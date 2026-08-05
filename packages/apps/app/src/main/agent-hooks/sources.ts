/**
 * The desktop app's copy of the hook file bodies, inlined by Vite at build time.
 *
 * This module exists so the `?raw` imports live in exactly ONE app-owned file.
 * The installers themselves moved to `@slayzone/platform/agent-hooks` to be
 * shared with the standalone runner, and deliberately own no bundler syntax —
 * the runner inlines the same two files with esbuild's `text` loader instead.
 * Keeping `?raw` behind this seam is the same reason `pty-manager` takes its
 * hook-reinstall function by injection rather than importing the app graph.
 *
 * Static (not dynamic) imports so the content lands in this chunk and the
 * packaged app never has to find these files on disk at runtime.
 */
// @ts-expect-error -- ?raw is a Vite build feature, not a typed module.
import notifyScriptRaw from '@slayzone/hooks/notify.sh?raw'
// @ts-expect-error -- ?raw is a Vite build feature, not a typed module.
import opencodePluginRaw from '@slayzone/hooks/opencode-plugin.js?raw'

const asString = (v: unknown): string => (typeof v === 'string' ? v : String(v))

export const NOTIFY_SCRIPT_SOURCE = asString(notifyScriptRaw)
export const OPENCODE_PLUGIN_SOURCE = asString(opencodePluginRaw)
