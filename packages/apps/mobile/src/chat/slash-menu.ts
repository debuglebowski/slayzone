/**
 * The `/` menu of the chat composer, as plain data: which commands it offers, in what
 * order, and what a tap or Send does — desktop's (`task-terminals` chat
 * autocomplete), built from its DOM-free parts (`@slayzone/task-terminals/slash-commands`:
 * the builtins registry, the CLI's list, command files as the CLI names them, the fuzzy
 * ranking, what Enter picks). The menu shows while the draft is a lone `/token`
 * (`slashQuery`); a phone has no arrow keys, so the top entry is the selected one.
 *
 * Desktop's sources, in its registration order: command files, agents, the app's
 * builtins, skills, the CLI's own commands (behind a richer local entry of the same
 * name). Not offered here: `@` file mentions.
 */
import {
  availableBuiltins,
  type BuiltinCommand,
  cliCommandItems,
  customCommandItems,
  expandCommandBody,
  rankByName,
  resolveEnter,
  takesArguments,
  transformCommandSubmit
} from '@slayzone/task-terminals/slash-commands'
import {
  type AgentInfo,
  CHAT_EFFORTS,
  type ChatCapabilities,
  type ChatEffort,
  type CliCommandList,
  type CommandInfo,
  isValidModelForMode,
  modelsForMode,
  type SkillInfo
} from '@slayzone/terminal-contracts'

/** What the hub lists for the chat's folder; undefined = not loaded (yet). */
export interface SlashLists {
  skills: readonly SkillInfo[] | undefined
  /** `chat.listCommands` — nested where the CLI runs commands itself. */
  commands: readonly CommandInfo[] | undefined
  agents: readonly AgentInfo[] | undefined
  /** The CLI's own list (live `turn-init`, else the last one the project saw). */
  cliList: CliCommandList | null
}

/** Desktop's source ids: usage counts are kept per (source, name). */
export type SlashSourceId = 'commands' | 'agents' | 'builtins' | 'skills' | 'cli-commands'

interface SlashBase {
  key: string
  source: SlashSourceId
  name: string
  description: string
}
export type SlashItem =
  | (SlashBase & { type: 'command'; command: CommandInfo })
  | (SlashBase & { type: 'agent' })
  | (SlashBase & { type: 'builtin'; builtin: BuiltinCommand })
  | (SlashBase & { type: 'skill' })
  /** `argumentHint`: what the CLI says the command takes (its `initialize` reply); '' = nothing / unknown. */
  | (SlashBase & { type: 'cli'; argumentHint: string })

/** `chat.getAutocompleteUsage`: picks per source and name. */
export type SlashUsage = Record<string, Record<string, number>>

/** What a pick does. `draft` is the composer's text afterwards. */
export type SlashAction =
  | { type: 'run'; builtin: BuiltinCommand; draft: string }
  | { type: 'draft'; draft: string; hint?: string }
  | { type: 'send'; text: string; draft: string }

/** The command name typed so far while the draft is a lone `/token`; null = no menu. */
export function slashQuery(draft: string): string | null {
  if (!draft.startsWith('/')) return null
  const rest = draft.slice(1)
  return /\s/.test(rest) ? null : rest
}

export function slashItems(lists: SlashLists, caps: ChatCapabilities): SlashItem[] {
  const cliList = caps.nativeSlashCommands ? lists.cliList : null
  const cli = cliCommandItems(cliList)
  // Where the CLI runs command files itself it gets `/name args` under the name it
  // runs them by; otherwise this app expands them (`planSend`).
  const commands = caps.nativeSlashCommands
    ? customCommandItems(lists.commands ?? [], cliList)
    : [...(lists.commands ?? [])]
  const builtins = availableBuiltins({
    cliCommandNames: new Set(cli.map((c) => c.name)),
    capabilities: caps
  })
  const items: SlashItem[] = [
    ...commands.map((c) => ({
      type: 'command' as const,
      key: `commands:${c.source}:${c.name}`,
      source: 'commands' as const,
      name: c.name,
      description: c.description,
      command: c
    })),
    ...(lists.agents ?? []).map((a) => ({
      type: 'agent' as const,
      key: `agents:${a.source}:${a.name}`,
      source: 'agents' as const,
      name: a.name,
      description: a.description
    })),
    ...builtins.map((b) => ({
      type: 'builtin' as const,
      key: `builtins:${b.name}`,
      source: 'builtins' as const,
      name: b.name,
      description: b.description,
      builtin: b
    })),
    ...(lists.skills ?? []).map((s) => ({
      type: 'skill' as const,
      key: `skills:${s.source}:${s.name}`,
      source: 'skills' as const,
      name: s.name,
      description: s.description
    }))
  ]
  // The CLI's own entries hide behind a builtin, skill or command file of that name.
  const taken = new Set(items.filter((i) => i.type !== 'agent').map((i) => i.name))
  for (const c of cli) {
    if (taken.has(c.name)) continue
    items.push({
      type: 'cli',
      key: `cli-commands:${c.name}`,
      source: 'cli-commands',
      name: c.name,
      description: c.description,
      argumentHint: c.argumentHint
    })
  }
  return items
}

/** Desktop's cross-source ranking: name hits, then description hits; exact first; usage, then name. */
export function rankSlash(items: SlashItem[], query: string, usage: SlashUsage): SlashItem[] {
  return rankByName(items, query, {
    getName: (i) => i.name,
    getDescription: (i) => i.description,
    getUsage: (i) => usage[i.source]?.[i.name] ?? 0
  })
}

/** A tap on an entry (desktop's click / Tab): run it, or put it in the draft. */
export function acceptSlash(item: SlashItem, draft: string, caps: ChatCapabilities): SlashAction {
  switch (item.type) {
    case 'builtin':
      return { type: 'run', builtin: item.builtin, draft: '' }
    case 'agent':
      return { type: 'draft', draft: `Use the ${item.name} agent to ` }
    case 'command': {
      const cmd = item.command
      if (caps.nativeSlashCommands) {
        return takesArguments(cmd)
          ? { type: 'draft', draft: `/${cmd.name} `, hint: argumentsHint(cmd) }
          : { type: 'draft', draft: `/${cmd.name} ` }
      }
      // Expanded here: a template waiting for arguments parks; one that needs none sends.
      if (/\$ARGUMENTS/.test(cmd.body) && draftArgs(draft).length === 0) {
        return { type: 'draft', draft: `/${cmd.name} `, hint: argumentsHint(cmd) }
      }
      const prompt = expandCommandBody(cmd.body, draftArgs(draft)).trim()
      return prompt ? { type: 'send', text: prompt, draft: '' } : { type: 'draft', draft: '' }
    }
    case 'cli':
      // Desktop shows the CLI's argument hint as ghost text after `/name `; here it is said.
      return item.argumentHint
        ? {
            type: 'draft',
            draft: `/${item.name} `,
            hint: `/${item.name} ${item.argumentHint}: type the arguments, then press Send`
          }
        : { type: 'draft', draft: `/${item.name} ` }
    default:
      return { type: 'draft', draft: `/${item.name} ` }
  }
}

/**
 * Send while the menu is open (desktop's Enter). Where the CLI runs slash commands, the
 * entry `resolveEnter` picks is sent as `/name` (or put in the draft when it needs
 * arguments), and a name matching nothing passes through for the CLI to answer;
 * otherwise the top entry is accepted.
 */
export function enterSlash(
  draft: string,
  ranked: SlashItem[],
  caps: ChatCapabilities
): SlashAction | { type: 'passthrough' } {
  const query = slashQuery(draft)
  if (query === null || ranked.length === 0) return { type: 'passthrough' }
  if (!caps.nativeSlashCommands) return acceptSlash(ranked[0], draft, caps)
  const resolution = resolveEnter({
    query,
    names: ranked.map((i) => i.name),
    selectedIndex: 0,
    navigated: false
  })
  if (resolution.kind === 'passthrough') return { type: 'passthrough' }
  const item = ranked[resolution.index]
  const text = submitText(item)
  return text === null ? acceptSlash(item, draft, caps) : { type: 'send', text, draft: '' }
}

/** What a send of `text` does (desktop's composer `handleSend`, before the queue). */
export type SendPlan =
  | { type: 'empty' }
  | { type: 'effort'; level: ChatEffort }
  | { type: 'model'; id: string }
  | { type: 'invalid'; message: string }
  | { type: 'send'; text: string }

export function planSend(
  raw: string,
  mode: string,
  caps: ChatCapabilities,
  commands: readonly CommandInfo[]
): SendPlan {
  const text = raw.trim()
  if (!text) return { type: 'empty' }
  // `/effort <level>`: the effort pill's path (provider config + respawn).
  const effort = /^\/effort\s+(\S+)\s*$/.exec(text)
  if (effort) {
    const level = effort[1].toLowerCase()
    return (CHAT_EFFORTS as readonly string[]).includes(level)
      ? { type: 'effort', level: level as ChatEffort }
      : {
          type: 'invalid',
          message: `Invalid effort level "${level}". Use: ${CHAT_EFFORTS.join(', ')}`
        }
  }
  // `/model <id>` where the CLI runs commands: its own /model would switch the running
  // process only, so it goes through the model pill's path.
  const model = caps.nativeSlashCommands ? /^\/model\s+(\S+)\s*$/.exec(text) : null
  if (model) {
    const id = model[1]
    return isValidModelForMode(mode, id)
      ? { type: 'model', id }
      : {
          type: 'invalid',
          message: `Unknown model "${id}". Use: ${modelsForMode(mode)
            .map((m) => m.id)
            .join(', ')}`
        }
  }
  if (!caps.nativeSlashCommands) {
    const expanded = transformCommandSubmit(text, [...commands])
    if (expanded?.send) return { type: 'send', text: expanded.send }
  }
  return { type: 'send', text }
}

/**
 * The entry a sent message's leading `/name` counts a use for (`chat.bumpAutocompleteUsage`):
 * the one picked from the menu, else the first of that name in desktop's source order.
 */
export function usageTarget(
  text: string,
  items: SlashItem[],
  picked: { source: string; name: string } | null
): { source: string; name: string } | null {
  const token = /^\/([a-zA-Z0-9_:-]+)/.exec(text.trim())?.[1]
  if (!token) return null
  if (picked && picked.name === token) return picked
  const hit = items.find((i) => i.name === token)
  return hit ? { source: hit.source, name: hit.name } : null
}

/** Desktop's `submitText` per source: null = accept instead (arguments still needed). */
function submitText(item: SlashItem): string | null {
  switch (item.type) {
    case 'command':
      return takesArguments(item.command) ? null : `/${item.name}`
    case 'skill':
    case 'cli':
      return `/${item.name}`
    default:
      return null
  }
}

function argumentsHint(cmd: CommandInfo): string {
  const usage = cmd.argumentHint ? `/${cmd.name} ${cmd.argumentHint}` : `/${cmd.name}`
  return `${usage}: type the arguments, then press Send`
}

/** What follows the command name in the draft (none while the menu is open). */
function draftArgs(draft: string): string {
  return draft.replace(/^\/\S*\s*/, '').trim()
}
