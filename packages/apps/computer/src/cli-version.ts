/**
 * The version of an agent CLI on this computer, as the binary a spawn here would
 * run reports it (`pty.cliVersion`).
 *
 * The hub gates launch flags a CLI only knows from some release on — codex
 * `--no-daemon` — on this answer, because an older CLI rejects a flag it doesn't
 * know and exits. So the answer must be about THIS machine's binary, never the
 * hub's.
 *
 * Cached per resolved file and its identity (mtime + size + inode): an agent spawn
 * asks every time, and `--version` of a node-shim CLI costs a process start. An
 * upgrade in place replaces the file, which changes its identity, so the next ask
 * reads the new version instead of trusting a stale one.
 *
 * @module computer/cli-version
 */
import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { platform } from 'node:os'
import { findOnPath } from '@slayzone/platform'

/** How long one `--version` may take before the version counts as unknown. */
const CLI_VERSION_TIMEOUT_MS = 5000

/** The first `major.minor[.patch]` in a `--version` output; null when there is none. */
export function parseCliVersion(output: string): string | null {
  const m = output.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!m) return null
  return `${m[1]}.${m[2]}.${m[3] ?? '0'}`
}

function runVersion(file: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      ['--version'],
      // A Windows npm shim is a `.cmd`, which only a shell can run.
      { timeout: CLI_VERSION_TIMEOUT_MS, env, shell: platform() === 'win32' },
      (err, stdout) => resolve(err ? null : parseCliVersion(String(stdout)))
    )
  })
}

export interface CliVersionProbe {
  /** `binary`'s version on `env.PATH`; null when it isn't there or says none. */
  versionOf(binary: string, env: NodeJS.ProcessEnv): Promise<string | null>
}

export function createCliVersionProbe(): CliVersionProbe {
  const cache = new Map<string, { identity: string; version: string }>()
  return {
    async versionOf(binary, env) {
      const found = await findOnPath(binary, env)
      if (!found) return null
      let file: string
      let identity: string
      try {
        file = await realpath(found)
        const s = await stat(file)
        identity = `${s.mtimeMs}:${s.size}:${s.ino}`
      } catch {
        return null
      }
      const hit = cache.get(file)
      if (hit && hit.identity === identity) return hit.version
      // Run what PATH resolves (the shim), not its target: a node-script CLI needs
      // its shebang, and its target may be a file only the shim knows how to run.
      const version = await runVersion(found, env)
      // An unknown answer may be transient (a timeout under load): ask again next time.
      if (version !== null) cache.set(file, { identity, version })
      return version
    }
  }
}
