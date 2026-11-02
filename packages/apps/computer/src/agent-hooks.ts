/**
 * Install the agent lifecycle hooks this machine needs, at computer boot.
 *
 * WHY A COMPUTER DOES THIS AT ALL. Agent status — the running spinner, the unread
 * marker, turn boundaries — is driven entirely by hook events: the agent runs
 * `~/.slayzone/hooks/notify.sh`, which POSTs to whoever spawned it. The installers
 * used to live inside the desktop app and were called from exactly one place, so
 * a computer on a box where the app never runs installed nothing at all: no
 * notify.sh, no `~/.claude/settings.json` entry, therefore no hook, therefore
 * every agent it spawned looked permanently idle. The computer spawns agents, so
 * the computer has to install their hooks.
 *
 * MACHINE-WIDE PATHS, NOT `--root`. Everything here lands in `$HOME` —
 * `~/.slayzone/hooks/`, `~/.claude/settings.json`, `~/.codex/hooks.json`, … —
 * never under the computer's own `--root`, and that is enforced by resolving
 * through `getMachineSlayzoneDir()` rather than `getSlayzoneHomeDir()` (which
 * follows `SLAYZONE_ROOT` and would drag the hooks dir along with it). `--root`
 * can point anywhere and there can be several on one box, but the files being
 * written belong to OTHER tools that read exactly one path per machine — and
 * `~/.claude/settings.json` stores the notify.sh PATH, so a root-scoped answer
 * would have each computer write its own path and the last boot win.
 *
 * Because every writer now computes the same path and the same bytes, concurrent
 * installers converge rather than fight; the lock in `updateFileAtomically` keeps
 * the file itself consistent while they do.
 *
 * BEFORE ANY PTY. Called before the computer accepts work: an agent that starts
 * against a missing or half-written hook file produces exactly the "stuck
 * running" state this exists to prevent.
 *
 * BEST-EFFORT. A failure here degrades status reporting; it must never stop a
 * computer from coming up and doing work. Logged, never thrown.
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

/** Release assets are immutable; sessions select one directory via their environment. */
export async function stageComputerHooks(
  root: string,
  version: string,
  installGlobal = false
): Promise<string> {
  const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  if (!/^[0-9A-Za-z.-]+$/.test(version) || version.includes('..'))
    throw new Error('invalid hook release')
  const dir = join(root, 'computer-runtime', 'hook-assets', version)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const notify = join(dir, 'notify.sh')
  const immutable = (path: string, source: string, mode: number): void => {
    try {
      writeFileSync(path, source, { mode, flag: 'wx' })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (readFileSync(path, 'utf8') !== source)
        throw new Error('installed hook release differs from immutable assets')
    }
  }
  immutable(notify, asString(notifyScriptRaw), 0o700)
  immutable(
    join(dir, 'opencode-plugin.mjs'),
    asString(opencodePluginRaw).split('{{NOTIFY_PATH}}').join(notify.replace(/\\/g, '/')),
    0o600
  )
  if (installGlobal) {
    const { getHooksDir } = await import('@slayzone/platform')
    const hooks = getHooksDir()
    // Legacy/default consumers keep a version-gated fallback. Computer sessions
    // always use their own immutable release, independent of other hub rollbacks.
    await installNotifyScript({
      source: asString(notifyScriptRaw),
      targetPath: join(hooks, 'notify-default.sh')
    })
    const fallback = join(hooks, 'notify-default.sh').replace(/'/g, "'\\''")
    const dispatcher = `#!/usr/bin/env bash\n# SLAYZONE_NOTIFY_VERSION=2147483647\n# SLAYZONE_COMPUTER_DISPATCHER=1\nif [ -n "\${SLAYZONE_COMPUTER_HOOK_DIR:-}" ]; then\n  exec bash "$SLAYZONE_COMPUTER_HOOK_DIR/notify.sh" "$@"\nfi\nexec bash '${fallback}' "$@"\n`
    const { path: scriptPath } = await installNotifyScript({ source: dispatcher })
    await installClaudeHooks({ scriptPath })
    await installCodexHooks({ scriptPath })
    await installGeminiHooks({ scriptPath })
    await installAntigravityHooks({ scriptPath })
    const pluginFallback = join(hooks, 'opencode-default.mjs')
    writeFileSync(
      pluginFallback,
      asString(opencodePluginRaw).split('{{NOTIFY_PATH}}').join(scriptPath.replace(/\\/g, '/')),
      { mode: 0o600 }
    )
    const wrapper = `// SLAYZONE_COMPUTER_DISPATCHER=1\nimport { pathToFileURL } from 'node:url';\nexport const SlayzoneNotifyPlugin = async (context) => {\n const p = process.env.SLAYZONE_COMPUTER_HOOK_DIR ? process.env.SLAYZONE_COMPUTER_HOOK_DIR + '/opencode-plugin.mjs' : ${JSON.stringify(pluginFallback)};\n return (await import(pathToFileURL(p).href)).SlayzoneNotifyPlugin(context);\n};\n`
    await installOpencodePlugin({ source: wrapper, notifyPath: scriptPath })
  }
  return dir
}
