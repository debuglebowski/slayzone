/**
 * `agentConfig.fs`: the filesystem the hub's AI-config ops (instructions, skills,
 * MCP config) read and write, served by THIS computer through the same
 * `localAiConfigFs` the hub uses for its own disk.
 *
 * The jail: a project file must lie inside `allowedRoots` (as every fs./git. path);
 * a computer-level one only inside this computer's own provider dirs under its home
 * (`COMPUTER_PROVIDER_PATHS`: `~/.claude`, `~/.codex`, …) — never elsewhere in home
 * (`~/.ssh`, shell rc files). Both ends of a rename are checked.
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
import { assertPathAllowed, writeFileWithinRoots } from '../config'
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
  const allow = (candidate: string): string => assertPathAllowed(candidate, roots())

  async function agentConfigFs(raw: unknown): Promise<{ result: unknown }> {
    const p = agentConfigFsParamsSchema.parse(raw)
    const fs = localAiConfigFs
    switch (p.op) {
      case 'homedir':
        return { result: homedir() }
      case 'exists':
        allow(p.path)
        return { result: await fs.exists(p.path) }
      case 'readFile':
        allow(p.path)
        return { result: await fs.readFile(p.path) }
      case 'writeFile':
        // Written where it was judged, re-checked at the open, never through a link.
        writeFileWithinRoots(allow(p.path), p.content, roots())
        return { result: null }
      case 'mkdir':
        allow(p.path)
        await fs.mkdir(p.path)
        return { result: null }
      case 'unlink':
        allow(p.path)
        await fs.unlink(p.path)
        return { result: null }
      case 'rmdir':
        allow(p.path)
        await fs.rmdir(p.path)
        return { result: null }
      case 'rename':
        allow(p.path)
        allow(p.to)
        await fs.rename(p.path, p.to)
        return { result: null }
      case 'stat':
        allow(p.path)
        return { result: await fs.stat(p.path) }
      case 'readdir':
        allow(p.path)
        return { result: await fs.readdir(p.path) }
    }
  }

  return { [HubToComputerMethods.agentConfigFs]: agentConfigFs }
}
