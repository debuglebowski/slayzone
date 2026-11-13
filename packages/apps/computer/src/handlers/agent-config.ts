/**
 * `agentConfig.fs`: the filesystem the hub's AI-config ops (instructions, skills,
 * MCP config) read and write, served by THIS computer through the same
 * `localAiConfigFs` the hub uses for its own disk.
 *
 * The jail: a project file must lie inside `allowedRoots` (as every fs./git. path);
 * a computer-level one only inside this computer's own provider dirs under its home
 * (`COMPUTER_PROVIDER_PATHS`: `~/.claude`, `~/.codex`, …) — never elsewhere in home
 * (`~/.ssh`, shell rc files). Both ends of a rename are checked. Every path is
 * judged by the computer's one path jail (`../path-jail`), reads go to the judged
 * path, and every write is done by the jail.
 *
 * @module computer/handlers/agent-config
 */
import { homedir as osHomedir } from 'node:os'
import { join, relative, resolve, isAbsolute } from 'node:path'
import { localAiConfigFs } from '@slayzone/ai-config/config-fs'
import { COMPUTER_PROVIDER_PATHS } from '@slayzone/ai-config/shared'
import {
  HubToComputerMethods,
  agentConfigFsParamsSchema
} from '@slayzone/computer-transport/shared'
import { jailedFs, judgePath, outsideScopeJail, type JailAccess } from '../path-jail'
import type { HandlerContext, HubMethodTable } from './types'

export function createAgentConfigHandlers(
  ctx: HandlerContext,
  homedir: () => string = osHomedir
): HubMethodTable {
  /** This computer's provider dirs under home (`~/.claude`, …). */
  const providerRoots = (): string[] =>
    Object.values(COMPUTER_PROVIDER_PATHS).map((p) => join(homedir(), p.baseDir))
  /**
   * A provider-dir file is computer-level: judged by those dirs alone, outside the
   * request's path scope (a project's ops read them beside its own files). Any other
   * path is a project file: inside `allowedRoots` (live — `computer.setAllowedRoots`
   * edits them) AND inside the scope the hub authorized (§9 Phase 7c).
   */
  const allow = (candidate: string, access: JailAccess = 'read'): string => {
    const opts = { access, subtree: access === 'entry' }
    const providers = providerRoots()
    // Judged by the same roots as before scopes (allowedRoots + provider dirs): a
    // provider dir that does not exist yet still answers "absent" when an allowed
    // root holds it, never "outside".
    if (providers.some((root) => isUnder(candidate, root)))
      return outsideScopeJail(() =>
        judgePath(candidate, [...ctx.config.allowedRoots, ...providers], opts)
      )
    return judgePath(candidate, ctx.config.allowedRoots, opts)
  }

  async function agentConfigFs(raw: unknown): Promise<{ result: unknown }> {
    const p = agentConfigFsParamsSchema.parse(raw)
    const fs = localAiConfigFs
    switch (p.op) {
      case 'homedir':
        return { result: homedir() }
      case 'exists':
        return { result: await fs.exists(allow(p.path)) }
      case 'readFile':
        return { result: await fs.readFile(allow(p.path)) }
      case 'writeFile':
        jailedFs.writeFile(allow(p.path, 'write'), p.content)
        return { result: null }
      case 'mkdir':
        jailedFs.mkdir(allow(p.path, 'write'))
        return { result: null }
      case 'unlink':
        jailedFs.unlink(allow(p.path, 'entry'))
        return { result: null }
      case 'rmdir':
        jailedFs.rmdir(allow(p.path, 'entry'))
        return { result: null }
      case 'rename':
        // As `rename(2)`: an existing file at `to` is replaced.
        jailedFs.rename(allow(p.path, 'entry'), allow(p.to, 'entry'), { replace: true })
        return { result: null }
      case 'stat':
        return { result: await fs.stat(allow(p.path)) }
      case 'readdir':
        return { result: await fs.readdir(allow(p.path)) }
    }
  }

  return { [HubToComputerMethods.agentConfigFs]: agentConfigFs }
}

/** `candidate` lexically inside `root` (or it): only picks WHICH roots judge it. */
function isUnder(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
