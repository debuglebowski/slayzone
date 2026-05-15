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
