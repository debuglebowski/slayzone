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
import { join } from 'node:path'
import { localAiConfigFs } from '@slayzone/ai-config/config-fs'
import { COMPUTER_PROVIDER_PATHS } from '@slayzone/ai-config/shared'
import {
  HubToComputerMethods,
  agentConfigFsParamsSchema
} from '@slayzone/computer-transport/shared'
import { jailedFs, judgePath, type JailAccess } from '../path-jail'
import type { HandlerContext, HubMethodTable } from './types'

export function createAgentConfigHandlers(
  ctx: HandlerContext,
  homedir: () => string = osHomedir
): HubMethodTable {
  /** Allowed roots (live — `computer.setAllowedRoots` edits them) + provider dirs. */
  const roots = (): string[] => [
    ...ctx.config.allowedRoots,
    ...Object.values(COMPUTER_PROVIDER_PATHS).map((p) => join(homedir(), p.baseDir))
  ]
  const allow = (candidate: string, access: JailAccess = 'read'): string =>
    judgePath(candidate, roots(), { access, subtree: access === 'entry' })

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
