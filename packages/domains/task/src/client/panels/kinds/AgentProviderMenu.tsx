import { createElement } from 'react'
import { ChevronDown, Terminal as TerminalIcon } from 'lucide-react'
import type { PanelInstance } from '@slayzone/task-contracts'
import { terminalGroupIdsOf } from '@slayzone/task-contracts'
import type { AgentId } from '@slayzone/terminal-contracts'
import { getModeLabel, getVisibleModes, groupAgents } from '@slayzone/terminal'
import { MODE_ICONS, useTerminalGroupMode } from '@slayzone/task-terminals'
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@slayzone/ui'
import { useTaskPageContext } from '../TaskPageContext'

/**
 * An agent panel's provider (docs/plans/panel-model.md step 12): one "Agent"
 * panel type, the provider chosen on the panel — every mode the app runs. The
 * primary agent's is the task's agent (`task.agent_id`); another agent panel's is
 * the mode of its own agent terminal (terminal_tabs).
 */
export function useAgentPanelProvider(instance: PanelInstance): AgentId | null {
  const { task } = useTaskPageContext()
  const primary = instance.id === 'terminal'
  const firstGroup = primary ? null : (terminalGroupIdsOf(instance)[0] ?? null)
  const groupMode = useTerminalGroupMode(task.id, firstGroup)
  return primary ? task.agent_id : groupMode
}

/**
 * The provider picker: a caret ▾ on the active agent tab of a tab strip (`variant
 * "tab"`), or the provider's name and caret in the panel's own header when its
 * group shows no strip (`"header"`).
 */
export function AgentProviderMenu({
  instance,
  variant
}: {
  instance: PanelInstance
  variant: 'tab' | 'header'
}): React.JSX.Element | null {
  const { canEdit, agent } = useTaskPageContext()
  const { modes, setPanelProvider } = agent
  const current = useAgentPanelProvider(instance)
  if (!canEdit) return null
  const currentDef = current ? modes.find((m) => m.id === current) : undefined
  const currentLabel = currentDef ? getModeLabel(currentDef) : (current ?? 'Agent')
  const visible = getVisibleModes(modes, current)
  const { builtin, custom } = groupAgents(visible)
  const renderItem = (mode: (typeof visible)[number]): React.JSX.Element => {
    const ModeIcon = MODE_ICONS[mode.id as AgentId] ?? TerminalIcon
    return (
      <DropdownMenuRadioItem
        key={mode.id}
        value={mode.id}
        data-testid={`agent-provider-option-${mode.id}`}
      >
        <span className="flex items-center gap-2">
          {/* Decorative: the label names the provider (the logos carry a <title>). */}
          <span aria-hidden="true" className="flex">
            <ModeIcon className="size-3.5" />
          </span>
          {getModeLabel(mode)}
        </span>
      </DropdownMenuRadioItem>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Provider: ${currentLabel}`}
          title={`Provider: ${currentLabel}`}
          data-testid="agent-provider-menu"
          data-provider={current ?? ''}
          // The tab and strip drag on pointer down: the picker is no drag handle.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'shrink-0 flex items-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent outline-none focus-visible:ring-1 focus-visible:ring-ring',
            variant === 'tab' ? 'size-4 justify-center' : 'h-7 gap-1.5 px-2 text-xs'
          )}
        >
          {variant === 'header' && (
            <>
              <span aria-hidden="true" className="flex">
                {createElement((current && MODE_ICONS[current]) || TerminalIcon, {
                  className: 'size-3.5'
                })}
              </span>
              <span className="truncate max-w-32">{currentLabel}</span>
            </>
          )}
          <ChevronDown className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-max min-w-44"
        data-testid="agent-provider-menu-content"
      >
        <DropdownMenuLabel className="text-xs text-muted-foreground">Provider</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={current ?? ''}
          onValueChange={(value) => {
            if (value !== current && modes.some((m) => m.id === value))
              void setPanelProvider(instance.id, value as AgentId)
          }}
        >
          {builtin.map(renderItem)}
          {custom.length > 0 && builtin.length > 0 && <DropdownMenuSeparator />}
          {custom.map(renderItem)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
