import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Switch,
  toast
} from '@slayzone/ui'
import {
  AGENT_STARTUP_SETTING,
  DEFAULT_AGENT_STARTUP_MODE,
  parseAgentStartupMode,
  type AgentStartupMode,
  type AgentId
} from '@slayzone/terminal-contracts'
import { getVisibleModes, getModeLabel, groupAgents, useAgents } from '@slayzone/terminal'
import { useTRPC } from '../../trpc'
import { useDefaultAgent } from '../use-default-agent'

const AGENT_STARTUP_OPTIONS: Array<{
  value: AgentStartupMode
  label: string
  description: string
}> = [
  {
    value: 'manual',
    label: 'Manual',
    description: 'Every agent waits for you to click Start.'
  },
  {
    value: 'auto',
    label: 'Auto',
    description:
      'Agents that were running when the app closed start again, and new tasks start at once. Agents that were stopped or closed while idle wait for Start. Keeps one Claude Code booted in the background per project with open tabs, so new tasks start instantly.'
  },
  {
    value: 'instant',
    label: 'Instant',
    description:
      'Every agent starts when you open its task. Keeps one Claude Code booted in the background per project with open tabs, so new tasks start instantly.'
  }
]

/**
 * The Agent panel's hub-wide rows: read by the hub's own server code (task create,
 * the warm pool and boot restore, the idle-close sweep — `scope.ts` `hub` keys), so
 * they sit inside `<HubWideSection>` and edit the picked hub. Owns its own reads (the
 * terminal panel's `usePanelSettings` is the default hub's, for this client's UI).
 */
export function AgentHubSettings() {
  const trpc = useTRPC()
  const { modes } = useAgents()
  const { defaultAgentId, setDefaultAgentId } = useDefaultAgent()
  const startupQuery = useQuery(trpc.settings.get.queryOptions({ key: AGENT_STARTUP_SETTING }))
  const autoCloseQuery = useQuery(
    trpc.settings.get.queryOptions({ key: 'terminal_auto_close_idle' })
  )
  const idleValueQuery = useQuery(
    trpc.settings.get.queryOptions({ key: 'terminal_idle_close_value' })
  )
  const idleUnitQuery = useQuery(
    trpc.settings.get.queryOptions({ key: 'terminal_idle_close_unit' })
  )
  const { mutate } = useMutation(
    trpc.settings.set.mutationOptions({
      onError: (err) => toast.error(`Could not save: ${err.message}`)
    })
  )
  const setSetting = (key: string, value: string): void => mutate({ key, value })

  const [agentStartupMode, setAgentStartupMode] = useState<AgentStartupMode>(
    DEFAULT_AGENT_STARTUP_MODE
  )
  const [terminalAutoCloseIdle, setTerminalAutoCloseIdle] = useState(false)
  const [terminalIdleCloseValue, setTerminalIdleCloseValue] = useState('30')
  const [terminalIdleCloseUnit, setTerminalIdleCloseUnit] = useState('minutes')

  // Each new stored value re-seeds its control (which local edits override in
  // between) — adjusted while rendering, one block per setting.
  const [seenStartup, setSeenStartup] = useState<typeof startupQuery.data>()
  if (startupQuery.data !== seenStartup) {
    setSeenStartup(startupQuery.data)
    if (startupQuery.data !== undefined)
      setAgentStartupMode(parseAgentStartupMode(startupQuery.data))
  }
  const [seenAutoClose, setSeenAutoClose] = useState<typeof autoCloseQuery.data>()
  if (autoCloseQuery.data !== seenAutoClose) {
    setSeenAutoClose(autoCloseQuery.data)
    if (autoCloseQuery.data !== undefined) setTerminalAutoCloseIdle(autoCloseQuery.data === '1')
  }
  const [seenIdleValue, setSeenIdleValue] = useState<typeof idleValueQuery.data>()
  if (idleValueQuery.data !== seenIdleValue) {
    setSeenIdleValue(idleValueQuery.data)
    if (idleValueQuery.data) setTerminalIdleCloseValue(idleValueQuery.data)
  }
  const [seenIdleUnit, setSeenIdleUnit] = useState<typeof idleUnitQuery.data>()
  if (idleUnitQuery.data !== seenIdleUnit) {
    setSeenIdleUnit(idleUnitQuery.data)
    if (idleUnitQuery.data) setTerminalIdleCloseUnit(idleUnitQuery.data)
  }

  return (
    <>
      <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
        <span className="text-sm text-muted-foreground">Default agent provider</span>
        <Select value={defaultAgentId} onValueChange={(v) => setDefaultAgentId(v as AgentId)}>
          <SelectTrigger className="max-w-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            position="popper"
            align="start"
            className="min-w-[var(--radix-select-trigger-width)] max-h-none"
          >
            {(() => {
              const visibleModes = getVisibleModes(modes, defaultAgentId)
              const { builtin, custom } = groupAgents(visibleModes)
              return (
                <>
                  {builtin.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {getModeLabel(m)}
                    </SelectItem>
                  ))}
                  {custom.length > 0 && builtin.length > 0 && <SelectSeparator />}
                  {custom.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {getModeLabel(m)}
                    </SelectItem>
                  ))}
                </>
              )
            })()}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
        <span className="text-sm text-muted-foreground">Agent startup</span>
        <div className="flex items-center gap-2">
          <Select
            value={agentStartupMode}
            onValueChange={(v) => {
              const next = parseAgentStartupMode(v)
              setAgentStartupMode(next)
              setSetting(AGENT_STARTUP_SETTING, next)
            }}
          >
            <SelectTrigger className="w-32 shrink-0" data-testid="agent-startup-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              {AGENT_STARTUP_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {AGENT_STARTUP_OPTIONS.find((o) => o.value === agentStartupMode)?.description}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
        <span className="text-sm text-muted-foreground">Auto-close idle agents</span>
        <div className="flex items-center gap-2">
          <Switch
            checked={terminalAutoCloseIdle}
            onCheckedChange={(c) => {
              setTerminalAutoCloseIdle(c)
              setSetting('terminal_auto_close_idle', c ? '1' : '0')
            }}
          />
          <span className="text-xs text-muted-foreground">
            Close the agent after it sits idle to free memory; reopen from the Start screen (the
            conversation resumes). Other terminals are never closed.
          </span>
        </div>
      </div>
      {terminalAutoCloseIdle && (
        <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
          <span className="text-sm text-muted-foreground">Idle timeout</span>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              value={terminalIdleCloseValue}
              onChange={(e) => setTerminalIdleCloseValue(e.target.value)}
              onBlur={() => {
                const n = Math.max(1, Math.floor(Number(terminalIdleCloseValue) || 30))
                const v = String(n)
                setTerminalIdleCloseValue(v)
                setSetting('terminal_idle_close_value', v)
              }}
              className="w-24"
            />
            <Select
              value={terminalIdleCloseUnit}
              onValueChange={(u) => {
                setTerminalIdleCloseUnit(u)
                setSetting('terminal_idle_close_unit', u)
              }}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="seconds">Seconds</SelectItem>
                <SelectItem value="minutes">Minutes</SelectItem>
                <SelectItem value="hours">Hours</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </>
  )
}
