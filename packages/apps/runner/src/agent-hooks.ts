/**
 * Install the agent lifecycle hooks this machine needs, at runner boot.
 *
 * WHY A RUNNER DOES THIS AT ALL. Agent status — the running spinner, the unread
 * marker, turn boundaries — is driven entirely by hook events: the agent runs
 * `~/.slayzone/hooks/notify.sh`, which POSTs to whoever spawned it. The installers
 * used to live inside the desktop app and were called from exactly one place, so
 * a runner on a box where the app never runs installed nothing at all: no
 * notify.sh, no `~/.claude/settings.json` entry, therefore no hook, therefore
 * every agent it spawned looked permanently idle. The runner spawns agents, so
 * the runner has to install their hooks.
 *
 * MACHINE-WIDE PATHS, NOT `--root`. Everything here lands in `$HOME` —
 * `~/.slayzone/hooks/`, `~/.claude/settings.json`, `~/.codex/hooks.json`, … —
 * never under the runner's own `--root`. `--root` can point anywhere and there
 * can be several on one box, but the files being written belong to OTHER tools
 * that read exactly one path per machine. Two runners on one host therefore write
 * the same files, which is why the shared write primitive
 * (`updateFileAtomically`) is what keeps them from clobbering each other.
 *
 * BEFORE ANY PTY. Called before the runner accepts work: an agent that starts
 * against a missing or half-written hook file produces exactly the "stuck
 * running" state this exists to prevent.
 *
 * BEST-EFFORT. A failure here degrades status reporting; it must never stop a
 * runner from coming up and doing work. Logged, never thrown.
 */
import {
  installAntigravityHooks,
  installClaudeHooks,
  installCodexHooks,
  installGeminiHooks,
  installNotifyScript,
  installOpencodePlugin,
  uninstallCodexWrapper
} from '@slayzone/platform/agent-hooks'
// The `?raw` suffix is resolved at build time by the esbuild plugin in build.mjs
// (Vite's spelling, so this file reads the same as the desktop app's seam). The
// shared installers take these as parameters and own no bundler syntax.
// @ts-expect-error -- ?raw is a build feature, not a typed module.
import notifyScriptRaw from '@slayzone/hooks/notify.sh?raw'
// @ts-expect-error -- ?raw is a build feature, not a typed module.
import opencodePluginRaw from '@slayzone/hooks/opencode-plugin.js?raw'

const asString = (v: unknown): string => (typeof v === 'string' ? v : String(v))

export async function installAgentHooks(
  log: (message: string, meta?: Record<string, unknown>) => void
): Promise<void> {
  try {
    const { path: scriptPath } = await installNotifyScript({
      source: asString(notifyScriptRaw)
    })
    await installClaudeHooks({ scriptPath })
    await installCodexHooks({ scriptPath })
    // Legacy ~/.slayzone/bin/codex bash wrapper from older installs.
    await uninstallCodexWrapper()
    await installGeminiHooks({ scriptPath })
    await installAntigravityHooks({ scriptPath })
    await installOpencodePlugin({
      notifyPath: scriptPath,
      source: asString(opencodePluginRaw)
    })
    log('agent hooks installed', { scriptPath })
  } catch (err) {
    log('agent hook install failed (non-fatal — agent status may not update)', {
      error: err instanceof Error ? err.message : String(err)
    })
  }
}
