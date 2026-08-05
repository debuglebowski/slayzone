/**
 * Agent lifecycle hook installers — shared by EVERY process that can spawn an
 * agent, which since the hub/runner split means the desktop app AND a standalone
 * runner.
 *
 * WHY THIS IS NOT IN THE APP ANYMORE. These lived under
 * `apps/app/src/main/agent-hooks/`, called from exactly one place. A runner on a
 * box where the desktop app never runs therefore installed nothing: no
 * `~/.slayzone/hooks/notify.sh`, no `~/.claude/settings.json` entry, so no hook
 * ever fired and every agent it spawned showed no running state and no unread
 * marker. Hook-driven status is most of what the terminal UI is, so a remote
 * runner was silently missing it.
 *
 * NO BUNDLER SYNTAX LIVES HERE. The two installers that ship a file body take
 * that body as a required `source` parameter instead of importing it. The app
 * inlines it with Vite (`?raw`), the runner with esbuild (`text` loader) — one
 * shared implementation, each composition root supplying content the way its own
 * build understands. A runtime read would be simpler but cannot work: the
 * `@slayzone/hooks` package is private and never published, and the runner ships
 * as a single self-contained bundle.
 *
 * MACHINE-WIDE, NEVER ROLE- OR CHANNEL-SCOPED. Every path here resolves through
 * `getSlayzoneHomeDir()` / the `get*SettingsPath()` helpers, i.e. `~/.slayzone`
 * and `~/.claude` — deliberately NOT `getSupervisedRoot()`. The files being
 * written belong to OTHER tools whose own config is one file per machine, so
 * scoping ours by release channel would just move the collision into their
 * config instead of removing it. Concurrency between installers is handled in
 * the write primitive (`updateFileAtomically`), not by giving each writer its
 * own directory.
 *
 * @module platform/agent-hooks
 */
export { installNotifyScript, parseNotifyVersion } from './notify-script-installer'
export type { InstallNotifyScriptOpts } from './notify-script-installer'
export { installClaudeHooks, CLAUDE_HOOK_EVENTS } from './claude-hook-installer'
export type { InstallClaudeHooksOpts, InstallClaudeHooksResult } from './claude-hook-installer'
export { installGeminiHooks, GEMINI_HOOK_EVENTS } from './gemini-hook-installer'
export type { InstallGeminiHooksOpts, InstallGeminiHooksResult } from './gemini-hook-installer'
export { installCodexHooks, uninstallCodexWrapper, CODEX_HOOK_EVENTS } from './codex-hook-installer'
export type { InstallCodexHooksOpts, InstallCodexHooksResult } from './codex-hook-installer'
export { installAntigravityHooks, ANTIGRAVITY_HOOK_EVENTS } from './antigravity-hook-installer'
export type {
  InstallAntigravityHooksOpts,
  InstallAntigravityHooksResult
} from './antigravity-hook-installer'
export { installOpencodePlugin } from './opencode-plugin-installer'
export type {
  InstallOpencodePluginOpts,
  InstallOpencodePluginResult
} from './opencode-plugin-installer'
export { formatHookCommand, toPosixPath } from './hook-paths'
