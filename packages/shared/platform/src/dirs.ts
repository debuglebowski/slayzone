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
 * User-visible SlayZone home/root dir — the single anchor for on-disk state.
 * For standalone hub/runner, everything (hub.config.json/hub.state.json or
 * runner.config.json, the DB, logs, runner creds) derives directly from it.
 * For the desktop app it anchors only what's genuinely machine-wide and
 * channel-agnostic — `hooks/`, `bin/` — since per-channel supervised state
 * derives from {@link getSupervisedRoot} instead, not this function directly.
 * Distinct from getStateDir() (Electron app state).
 *
 * Resolution (pure env reader — no CWD default here): `SLAYZONE_ROOT` >
 * `$HOME/.slayzone`. Standalone hub/runner entrypoints seed
 * `SLAYZONE_ROOT=process.cwd()` before any reader runs, so a remote deploy
 * anchors to the launch dir; the Electron app leaves it unset and falls through
 * to `~/.slayzone`. This function stays CWD-agnostic on purpose — the app main
 * process is NOT flagged SUPERVISED, so a CWD default gated here would wrongly
 * relocate the app's hook installers.
 *
 * Uses `process.env.HOME` first so an E2E fixture's `HOME` override redirects
 * writes deterministically.
 */
export function getSlayzoneHomeDir(): string {
  if (process.env.SLAYZONE_ROOT) return process.env.SLAYZONE_ROOT
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()
  return path.join(home, '.slayzone')
}

/**
 * The release channel this SlayZone process belongs to — `stable` / `beta` /
 * `dev` (or `unknown` when unset). Pure env reader: the Electron app main sets
 * `SLAYZONE_RELEASE_CHANNEL` at boot (derived from `app.isPackaged` + the version's
 * prerelease tag) BEFORE any sidecar / pty env is built; standalone hub/runner
 * boots and tests leave it unset → `unknown`.
 *
 * Two consumers now: attribution (packed into the opaque
 * `SLAYZONE_AGENT_HOOK_CONTEXT` blob so the server can log which release channel
 * a hook actually came from — the shared `~/.slayzone/hooks/notify.sh` is NOT
 * release-channel-scoped, so this makes a cross-channel clobber visible in
 * Diagnostics instead of silent), and control flow: {@link getSupervisedRoot}'s
 * default `channel` param reads this to fold `beta`/`stable`/`unknown` onto the
 * same `stable` bucket while keeping `dev` separate.
 */
export function getSlayzoneReleaseChannel(): string {
  const raw = process.env.SLAYZONE_RELEASE_CHANNEL?.trim()
  return raw ? raw : 'unknown'
}

/** A supervised (desktop-app-spawned) process's role — the sidecar acting as
 *  the local hub, or the co-located local runner. */
export type SlayzoneSupervisedRole = 'hub' | 'runner'

/**
 * Channel-scoped root for the desktop app's supervised sidecar/local-runner —
 * `~/.slayzone/<dev|stable>/<hub|runner>`. Two buckets, not three: `beta` folds
 * into `stable` (they already share one DB file today via `getDbName`'s
 * packaged-only boolean, and can't even run concurrently — the sidecar's fixed
 * port only has `prod`/`dev`/`test` buckets — so a separate `beta` bucket here
 * would buy no isolation that exists today). No empty/default case either:
 * `stable` is always spelled out, so it can never collide with a standalone
 * root someone names `hub` or `runner` directly under `~/.slayzone`.
 *
 * CALLER RESTRICTION: only the desktop app's own sidecar/local-runner spawn
 * code may call this. Hook installers and standalone hub/runner keep resolving
 * their own root via {@link getSlayzoneHomeDir} directly — misusing this
 * function there would silently break the "hooks stay unscoped" invariant
 * (`~/.slayzone/hooks/notify.sh` must stay outside any channel/role subfolder).
 */
export function getSupervisedRoot(
  role: SlayzoneSupervisedRole,
  channel: string = getSlayzoneReleaseChannel()
): string {
  const bucket = channel === 'dev' ? 'dev' : 'stable'
  return path.join(getSlayzoneHomeDir(), bucket, role)
}

/**
 * The MACHINE-WIDE SlayZone dir — `$HOME/.slayzone`, deliberately ignoring
 * `SLAYZONE_ROOT`.
 *
 * NOT the same question as {@link getSlayzoneHomeDir}, which answers "where does
 * THIS PROCESS keep its state" and correctly follows `SLAYZONE_ROOT` (a
 * standalone hub/runner anchors to its launch dir; the desktop app's supervised
 * roles are channel-scoped). This one answers "where do the files SHARED BY THE
 * WHOLE MACHINE live", and those must not move per process.
 *
 * The two coincide for the desktop app, which is why one resolver served both
 * for so long. They diverge for a runner — and the divergence is not cosmetic:
 * `notify.sh`'s path gets written INTO `~/.claude/settings.json`, which is one
 * file per machine that holds exactly one path. A root-scoped answer means two
 * runners with different roots each write their own path there and the last boot
 * wins, and a runner whose root was temporary leaves a path that no longer
 * exists. Anchoring on `$HOME` makes every writer compute the SAME path with the
 * SAME content, so concurrent installers converge instead of fighting.
 *
 * `SLAYZONE_MACHINE_DIR` redirects it so a test can exercise a real install
 * without touching the developer's actual `~/.slayzone` — the same escape hatch
 * `getClaudeSettingsPath()` and its siblings already provide for the files they
 * own. Env-manifest scope `infra`: a spawned terminal must never inherit it.
 */
export function getMachineSlayzoneDir(): string {
  if (process.env.SLAYZONE_MACHINE_DIR) return process.env.SLAYZONE_MACHINE_DIR
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()
  return path.join(home, '.slayzone')
}

/** `$HOME/.slayzone/hooks` — where the shared `notify.sh` lives. Machine-wide;
 *  see {@link getMachineSlayzoneDir} for why this must not follow SLAYZONE_ROOT. */
export function getHooksDir(): string {
  return path.join(getMachineSlayzoneDir(), 'hooks')
}

/** `$HOME/.slayzone/bin` — machine-wide shims (today only the legacy `codex`
 *  wrapper, which the installers remove). Same anchoring rule as the hooks dir. */
export function getSlayzoneBinDir(): string {
  return path.join(getMachineSlayzoneDir(), 'bin')
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
