import { modelsForMode, type ChatCapabilities } from '@slayzone/terminal-contracts'
import type { BuiltinCommand, AcceptCtx } from './types'
import { rankByName } from './ranking'
import { resetChat } from './chat-actions'

/**
 * The app's own slash commands. Each `run()` receives an `AcceptCtx` with chat
 * session handles, navigation hooks, and toast. Handlers prefer side-effects over
 * text insertion — actions happen via IPC or UI events.
 *
 * Everything else — `/compact`, `/context`, `/usage`, skills, plugin and MCP
 * commands — comes from the chat CLI's own list (`sources/cli-commands.ts`) and
 * runs in the CLI. A builtin exists only where the app must act itself: it owns
 * app state (`/clear`, `/effort`, `/model`) or opens app UI (settings, files,
 * links). `cliCollision` says which wins when the CLI has the same name.
 */
export const builtinCommands: BuiltinCommand[] = [
  {
    name: 'clear',
    description: 'Clear the chat — kill session and start fresh',
    cliCollision: 'app-wins',
    async run(ctx) {
      await resetChat(ctx.chat, ctx.session, {
        interruptFirst: true,
        onSuccess: () => ctx.toast('Chat cleared'),
        onError: (err) =>
          ctx.toast(`Clear failed: ${err instanceof Error ? err.message : String(err)}`)
      }).catch(() => {
        /* handled via onError */
      })
    }
  },
  {
    name: 'help',
    description: 'Show available slash commands',
    cliCollision: 'cli-wins',
    run(ctx) {
      ctx.toast(
        'Slash commands: type / for skills, commands, agents, and built-ins. Type @ for files.'
      )
    }
  },
  {
    name: 'bug',
    description: 'Open Claude Code issue tracker',
    cliCollision: 'app-wins',
    run(ctx) {
      ctx.navigate.openExternal('https://github.com/anthropics/claude-code/issues/new')
    }
  },
  {
    name: 'release-notes',
    description: 'Open Claude Code releases page',
    cliCollision: 'app-wins',
    run(ctx) {
      ctx.navigate.openExternal('https://github.com/anthropics/claude-code/releases')
    }
  },
  {
    name: 'config',
    description: 'Open settings',
    cliCollision: 'app-wins',
    run(ctx) {
      ctx.navigate.openSettings('appearance')
    }
  },
  {
    name: 'memory',
    description: 'Open project CLAUDE.md',
    cliCollision: 'app-wins',
    run(ctx) {
      const sep = ctx.session.cwd.endsWith('/') ? '' : '/'
      ctx.navigate.openFile(`${ctx.session.cwd}${sep}CLAUDE.md`)
    }
  },
  {
    name: 'permissions',
    description: 'Open permissions settings',
    cliCollision: 'app-wins',
    run(ctx) {
      ctx.navigate.openSettings('permissions')
    }
  },
  {
    name: 'hooks',
    description: 'Open hooks settings',
    cliCollision: 'app-wins',
    run(ctx) {
      ctx.navigate.openSettings('hooks')
    }
  },
  {
    name: 'mcp',
    description: 'Open MCP servers settings',
    cliCollision: 'app-wins',
    run(ctx) {
      ctx.navigate.openSettings('mcp')
    }
  },
  {
    name: 'init',
    description: 'Ask Claude to create CLAUDE.md for this project',
    cliCollision: 'cli-wins',
    async run(ctx) {
      await ctx.submit(
        'Initialize a CLAUDE.md file for this codebase. Include the stack, architecture, commands, and any conventions you can infer from the code.'
      )
    }
  },
  {
    name: 'review',
    description: 'Review the current diff or a PR',
    cliCollision: 'cli-wins',
    async run(ctx) {
      await ctx.submit(
        'Review the pending changes. Look for bugs, regressions, security issues, and anything that would not pass a thorough code review.'
      )
    }
  },
  {
    name: 'status',
    description: 'Show current chat session info',
    cliCollision: 'cli-wins',
    run(ctx) {
      ctx.toast(`Session: ${ctx.session.mode} — cwd ${ctx.session.cwd}`)
    }
  },
  {
    name: 'model',
    description: 'Switch model — usage: /model <name>',
    cliCollision: 'app-wins',
    // The CLI's own /model would switch the running process only: the model pill
    // and the next respawn's --model would not follow. Only needed where the
    // CLI runs slash commands itself.
    available: (caps) => caps.nativeSlashCommands,
    run(ctx) {
      // Park draft so user types the model, then handleSend intercepts on Enter.
      ctx.setDraft('/model ')
      const ids = modelsForMode(ctx.session.mode).map((m) => m.id)
      ctx.toast(`model: type one of ${ids.join(', ')} then Enter`)
    }
  },
  {
    name: 'effort',
    description: 'Set reasoning effort — usage: /effort <low|medium|high|xhigh|max>',
    cliCollision: 'app-wins',
    run(ctx) {
      // Park draft so user types the level, then handleSend intercepts on Enter.
      ctx.setDraft('/effort ')
      ctx.toast('effort: type level (low, medium, high, xhigh, max) then Enter')
    }
  }
]

export function rankBuiltins(items: BuiltinCommand[], filter: string): BuiltinCommand[] {
  return rankByName(items, filter, {
    getName: (b) => b.name,
    getDescription: (b) => b.description
  })
}

export function filterBuiltins(filter: string): BuiltinCommand[] {
  return rankBuiltins(builtinCommands, filter)
}

export interface BuiltinsSourceOpts {
  /** Commands the chat CLI runs itself (its list minus terminal-only ones); empty when unknown. */
  cliCommandNames: ReadonlySet<string>
  capabilities: ChatCapabilities
}

/** Builtins offered for this chat: available for the mode, and not shadowed by a CLI-native command. */
export function availableBuiltins(opts: BuiltinsSourceOpts): BuiltinCommand[] {
  return builtinCommands.filter(
    (b) =>
      (b.available?.(opts.capabilities) ?? true) &&
      !(b.cliCollision === 'cli-wins' && opts.cliCommandNames.has(b.name))
  )
}

export type AcceptCtxRef = AcceptCtx
