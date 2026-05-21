/**
 * Path formatting for agent hook `command` strings.
 *
 * Agent CLIs (Claude Code, Gemini CLI) run hook `command` entries through a
 * POSIX shell — bash, which on Windows means Git Bash. A raw Windows path like
 * `C:\Users\Jane\.slayzone\hooks\notify.sh` is mangled by bash: the backslashes
 * are eaten as escape characters, yielding `C:UsersJane.slayzonehooksnotify.sh`
 * and a "No such file or directory" error every hook invocation (issue #88).
 *
 * The fix: store the hook command as a forward-slash path, POSIX-quoted when it
 * contains characters the shell would otherwise interpret. Git Bash accepts
 * mixed `C:/Users/...` paths, and macOS/Linux paths are unaffected.
 */

/** Convert Windows backslashes to forward slashes. No-op on POSIX paths. */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/')
}

/**
 * Format an absolute path for use as a hook `command` value.
 *
 * Always forward-slashed. POSIX-single-quoted ONLY when the path contains
 * whitespace or shell-special characters — quoting is POSIX unconditionally
 * because the hook always runs under bash, even on Windows (so this is NOT
 * `quoteForShell`, which is cmd.exe-style on Windows).
 *
 * Quote-only-when-needed keeps the common macOS/Linux path byte-identical to
 * the pre-fix value, so existing users get no settings.json churn — only
 * Windows paths and paths with spaces (both currently broken) change.
 */
export function formatHookCommand(absPath: string): string {
  const posix = toPosixPath(absPath)
  if (!/[\s'"\\$`&|;<>()*?]/.test(posix)) return posix
  return `'${posix.replace(/'/g, `'"'"'`)}'`
}
