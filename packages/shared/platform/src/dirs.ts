import path from 'path'
import os from 'os'

/**
 * Returns the directory for all app state (DB, backups, Electron internal data).
 *
 * - macOS: ~/Library/Application Support/slayzone
 * - Windows: %APPDATA%/slayzone
 * - Linux: $XDG_STATE_HOME/slayzone or ~/.local/state/slayzone
 */
export function getStateDir(): string {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'slayzone')
    case 'win32':
      return path.join(process.env.APPDATA ?? os.homedir(), 'slayzone')
    default: {
      const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state')
      return path.join(stateHome, 'slayzone')
    }
  }
}

/**
 * User-visible SlayZone home/root dir — the single anchor for on-disk state
 * (config.json, hooks, and for standalone hub/runner the DB, logs, and runner
 * creds all derive from it). Distinct from getStateDir() (Electron app state).
 *
 * Resolution (pure env reader — no CWD default here): `SLAYZONE_ROOT` >
 * `SLAYZONE_HOME_DIR` (back-compat alias) > `$HOME/.slayzone`. Standalone
 * hub/runner entrypoints seed `SLAYZONE_ROOT=process.cwd()` before any reader
 * runs, so a remote deploy anchors to the launch dir; the Electron app leaves
 * it unset and falls through to `~/.slayzone`. This function stays CWD-agnostic
 * on purpose — the app main process is NOT flagged SUPERVISED, so a CWD default
 * gated here would wrongly relocate the app's hook installers.
 *
 * Uses `process.env.HOME` first so an E2E fixture's `HOME` override redirects
 * writes deterministically.
 */
export function getSlayzoneHomeDir(): string {
  if (process.env.SLAYZONE_ROOT) return process.env.SLAYZONE_ROOT
  if (process.env.SLAYZONE_HOME_DIR) return process.env.SLAYZONE_HOME_DIR
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()
  return path.join(home, '.slayzone')
}

/**
 * Absolute path to the user's Claude Code settings.json. Honours
 * `SLAYZONE_CLAUDE_SETTINGS_PATH` so tests can redirect without overriding HOME.
 */
export function getClaudeSettingsPath(): string {
  if (process.env.SLAYZONE_CLAUDE_SETTINGS_PATH) return process.env.SLAYZONE_CLAUDE_SETTINGS_PATH
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()
  return path.join(home, '.claude', 'settings.json')
}

/**
 * Absolute path to the user's Gemini CLI settings.json (v0.13.0+). Honours
 * `SLAYZONE_GEMINI_SETTINGS_PATH` for tests.
 */
export function getGeminiSettingsPath(): string {
  if (process.env.SLAYZONE_GEMINI_SETTINGS_PATH) return process.env.SLAYZONE_GEMINI_SETTINGS_PATH
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()
  return path.join(home, '.gemini', 'settings.json')
}

/**
 * Absolute path to the user's Codex CLI hooks.json (hooks system, stable
 * 0.129+). Honours `SLAYZONE_CODEX_HOOKS_PATH` for tests.
 */
export function getCodexHooksPath(): string {
  if (process.env.SLAYZONE_CODEX_HOOKS_PATH) return process.env.SLAYZONE_CODEX_HOOKS_PATH
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()
  return path.join(home, '.codex', 'hooks.json')
}

/**
 * Absolute path to the user-global Antigravity CLI (`agy`) hooks file.
 * Confirmed against the real CLI: `agy` loads hooks from
 * `~/.gemini/config/hooks.json` (its customization dir is the Gemini dir).
 * Honours `SLAYZONE_ANTIGRAVITY_HOOKS_PATH` for tests.
 */
export function getAntigravityHooksPath(): string {
  if (process.env.SLAYZONE_ANTIGRAVITY_HOOKS_PATH)
    return process.env.SLAYZONE_ANTIGRAVITY_HOOKS_PATH
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()
  return path.join(home, '.gemini', 'config', 'hooks.json')
}

/**
 * Absolute path to the SlayZone-managed OpenCode plugin file. OpenCode loads
 * `*.js` from `${XDG_CONFIG_HOME:-~/.config}/opencode/plugin/`. Honours
 * `SLAYZONE_OPENCODE_PLUGIN_PATH` so tests can redirect without overriding HOME.
 */
export function getOpencodePluginPath(): string {
  if (process.env.SLAYZONE_OPENCODE_PLUGIN_PATH) return process.env.SLAYZONE_OPENCODE_PLUGIN_PATH
  const configHome =
    process.env.XDG_CONFIG_HOME ||
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? os.homedir(), '.config')
  return path.join(configHome, 'opencode', 'plugin', 'slayzone-notify.js')
}
