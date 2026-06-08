import { parseShellArgs } from './flag-parser'
import type { SpawnBinaryInfo } from './types'

export interface InterpolateTemplateOpts {
  template: string
  conversationId?: string
  flags: string[]
  initialPrompt?: string
}

export function interpolateTemplate(opts: InterpolateTemplateOpts): SpawnBinaryInfo {
  const flagsStr = opts.flags.join(' ')
  const interpolated = opts.template
    .replace(/\{flags\}/g, flagsStr)
    .replace(/\{id\}/g, opts.conversationId ?? '')
    .replace(/\s+/g, ' ')
    .trim()

  const parts = parseShellArgs(interpolated)
  const name = parts[0] || ''
  const args = parts.slice(1)

  return {
    name,
    args,
    providerArgs: [],
    initialPrompt: opts.initialPrompt
  }
}
