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
 * User-visible SlayZone home dir. Distinct from getStateDir() (Electron app
 * state) — this hosts assets surfaced to external tools, e.g. the agent hook
 * notify script that lands at `~/.slayzone/hooks/notify.sh`.
 *
 * Honours `SLAYZONE_HOME_DIR` for E2E sandboxing and power-user relocation.
 * Uses `process.env.HOME` first so an E2E fixture's `HOME` override
 * redirects writes deterministically.
 */
export function getSlayzoneHomeDir(): string {
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
