import { useState, useEffect, useRef, type ComponentProps } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import { ChevronRight, Copy, HelpCircle, Plus, RefreshCw, Trash2, CheckCircle2, AlertCircle } from 'lucide-react'
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, IconButton, Input, Label, Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue, Switch, Tooltip, TooltipTrigger, TooltipContent, toast } from '@slayzone/ui'
import { getVisibleModes, getModeLabel, groupTerminalModes } from '@slayzone/terminal'
import type { TerminalMode, TerminalModeInfo, CreateTerminalModeInput, UpdateTerminalModeInput, UsageProviderConfig, UsageWindow } from '@slayzone/terminal/shared'
import { DETECTION_ENGINES } from '@slayzone/terminal/shared'
import { SettingsTabIntro } from './SettingsTabIntro'
import { PanelBreadcrumb } from './PanelBreadcrumb'

function HelpTip({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <HelpCircle className="size-3 text-muted-foreground/50 hover:text-muted-foreground shrink-0 cursor-default" />
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 text-xs leading-relaxed">
        {children}
      </TooltipContent>
    </Tooltip>
  )
}

function FieldLabel({ label, tip }: { label: string; tip: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      <HelpTip>{tip}</HelpTip>
    </div>
  )
}

const EMPTY_USAGE_CONFIG: UsageProviderConfig = {
  enabled: false,
  url: '',
  method: 'GET',
  authType: 'none',
  windowMapping: { label: 'name', utilization: 'utilization', resetsAt: 'resets_at' },
}

function UsageConfigSection({
  mode,
  onUpdate,
}: {
  mode: TerminalModeInfo
  onUpdate: (id: string, updates: UpdateTerminalModeInput) => Promise<TerminalModeInfo | null>
}) {
  const config: UsageProviderConfig = mode.usageConfig ?? EMPTY_USAGE_CONFIG
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; windows?: UsageWindow[]; error?: string } | null>(null)

  const update = (patch: Partial<Omit<UsageProviderConfig, 'windowMapping'>> & { windowMapping?: Partial<UsageProviderConfig['windowMapping']> }) => {
    onUpdate(mode.id, {
      usageConfig: {
        ...config,
        ...patch,
        windowMapping: { ...config.windowMapping, ...patch.windowMapping },
      },
    })
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await getTrpcVanillaClient().app.usage.test.mutate(config)
      setTestResult(res)
      if (res.ok) toast.success(`Found ${res.windows?.length ?? 0} usage window(s)`)
      else toast.error(res.error ?? 'Test failed')
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message })
    } finally {
      setTesting(false)
    }
  }

  if (mode.isBuiltin) {
    return (
      <div className="pt-4 border-t border-border dark:border-border">
        <div className="rounded-xl border bg-surface-2/50 dark:bg-surface-0/30 p-5">
          <div className="flex items-center gap-2">
            <div className="size-2 rounded-full bg-blue-500" />
            <span className="text-sm font-medium">Usage Tracking</span>
            <span className="text-xs text-muted-foreground ml-auto">Built-in</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="pt-4 border-t border-border dark:border-border">
      <div className="rounded-xl border bg-surface-2/50 dark:bg-surface-0/30 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h4 className="text-sm font-semibold">Usage Tracking</h4>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Track rate limits from this provider's API.
            </p>
          </div>
          <Switch
            checked={config.enabled}
            onCheckedChange={(checked) => update({ enabled: checked })}
          />
        </div>

        {config.enabled && (
          <div className="space-y-4 pt-2">
            {/* URL + Method */}
            <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
              <FieldLabel label="URL" tip="The API endpoint that returns rate-limit or quota data. Must return JSON." />
              <div className="flex items-center gap-2">
                <Select value={config.method || 'GET'} onValueChange={(v) => update({ method: v as 'GET' | 'POST' })}>
                  <SelectTrigger size="sm" className="w-20 shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="GET">GET</SelectItem>
                    <SelectItem value="POST">POST</SelectItem>
                  </SelectContent>
                </Select>
                <DebouncedInput
                  className="font-mono text-xs flex-1"
                  placeholder="https://api.example.com/usage"
                  value={config.url}
                  onValueCommit={(v) => update({ url: v })}
                />
              </div>
            </div>

            {/* Auth Type */}
            <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
              <FieldLabel label="Auth Type" tip={<><strong>None</strong> — no auth header sent.<br /><strong>Env Variable</strong> — reads a token from an environment variable.<br /><strong>JSON File</strong> — reads a token from a JSON file on disk (e.g. ~/.my-cli/auth.json).<br /><strong>Keychain</strong> — reads a token from the macOS Keychain (e.g. CCS profiles).</>} />
              <Select value={config.authType} onValueChange={(v) => update({ authType: v as UsageProviderConfig['authType'] })}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="bearer-env">Env Variable</SelectItem>
                  <SelectItem value="file-json">JSON File</SelectItem>
                  <SelectItem value="keychain">Keychain</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Auth: Env Variable */}
            {config.authType === 'bearer-env' && (
              <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                <FieldLabel label="Env Var Name" tip="Name of the environment variable that holds your API token. The app reads it from its own process environment." />
                <DebouncedInput
                  className="font-mono text-xs"
                  placeholder="MY_API_TOKEN"
                  value={config.authEnvVar ?? ''}
                  onValueCommit={(v) => update({ authEnvVar: v })}
                />
              </div>
            )}

            {/* Auth: File JSON */}
            {config.authType === 'file-json' && (
              <>
                <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                  <FieldLabel label="File Path" tip="Absolute path to a JSON file containing your auth token. Use ~ for your home directory." />
                  <DebouncedInput
                    className="font-mono text-xs"
                    placeholder="~/.my-cli/auth.json"
                    value={config.authFilePath ?? ''}
                    onValueCommit={(v) => update({ authFilePath: v })}
                  />
                </div>
                <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                  <FieldLabel label="Token Path" tip={<>Dot-path to the token inside the JSON file. For example, if the file is <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">{'{"tokens":{"key":"abc"}}'}</code>, use <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">tokens.key</code>.<br /><br />Comma-separate multiple paths to try them in order (first match wins).</>} />
                  <DebouncedInput
                    className="font-mono text-xs"
                    placeholder="tokens.access_token"
                    value={Array.isArray(config.authFileTokenPath) ? config.authFileTokenPath.join(', ') : (config.authFileTokenPath ?? '')}
                    onValueCommit={(v) => {
                      const paths = v.split(',').map(s => s.trim()).filter(Boolean)
                      update({ authFileTokenPath: paths.length > 1 ? paths : paths[0] ?? '' })
                    }}
                  />
                </div>
              </>
            )}

            {/* Auth: Keychain */}
            {config.authType === 'keychain' && (
              <>
                <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                  <FieldLabel label="Service Name" tip="The macOS Keychain service name. For CCS profiles, use Claude Code-credentials-<suffix> where <suffix> is the SHA-256 hash prefix of the instance path." />
                  <DebouncedInput
                    className="font-mono text-xs"
                    placeholder="Claude Code-credentials-9f09856a"
                    value={config.authKeychainService ?? ''}
                    onValueCommit={(v) => update({ authKeychainService: v })}
                  />
                </div>
                <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                  <FieldLabel label="Token Path" tip={<>Dot-path to the token inside the Keychain JSON value. For Claude OAuth, use <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">claudeAiOauth.accessToken</code>. Leave empty if the value is the token itself.</>} />
                  <DebouncedInput
                    className="font-mono text-xs"
                    placeholder="claudeAiOauth.accessToken"
                    value={config.authKeychainTokenPath ?? ''}
                    onValueCommit={(v) => update({ authKeychainTokenPath: v })}
                  />
                </div>
              </>
            )}

            {/* Auth Header (shown for env + file) */}
            {config.authType !== 'none' && (
              <>
                <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                  <FieldLabel label="Header Name" tip="The HTTP header name used to send the token. Defaults to Authorization if left empty." />
                  <DebouncedInput
                    className="font-mono text-xs"
                    placeholder="Authorization"
                    value={config.authHeaderName ?? ''}
                    onValueCommit={(v) => update({ authHeaderName: v })}
                  />
                </div>
                <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                  <FieldLabel label="Header Template" tip={<>Template for the header value. <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">{'{token}'}</code> is replaced with the resolved token. Defaults to <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">Bearer {'{token}'}</code>.</>} />
                  <DebouncedInput
                    className="font-mono text-xs"
                    placeholder="Bearer {token}"
                    value={config.authHeaderTemplate ?? ''}
                    onValueCommit={(v) => update({ authHeaderTemplate: v })}
                  />
                </div>
              </>
            )}

            {/* Extra Headers */}
            {config.authType !== 'none' && (
              <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                <FieldLabel label="Extra Headers" tip={<>Additional HTTP headers as <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">key: value</code> pairs, one per line. Example: <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">anthropic-beta: oauth-2025-04-20</code></>} />
                <DebouncedInput
                  className="font-mono text-xs"
                  placeholder="anthropic-beta: oauth-2025-04-20"
                  value={config.extraHeaders ? Object.entries(config.extraHeaders).map(([k, v]) => `${k}: ${v}`).join('\n') : ''}
                  onValueCommit={(v) => {
                    const headers: Record<string, string> = {}
                    for (const line of v.split('\n')) {
                      const idx = line.indexOf(':')
                      if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
                    }
                    update({ extraHeaders: Object.keys(headers).length > 0 ? headers : undefined })
                  }}
                />
              </div>
            )}

            {/* Response Mapping */}
            <div className="pt-3 border-t border-border dark:border-border space-y-3">
              <div className="flex items-center gap-1.5">
                <h5 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Response Mapping</h5>
                <HelpTip>Configure how to extract rate-limit windows from the API's JSON response. Each window becomes a usage bar.</HelpTip>
              </div>

              <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                <FieldLabel label="Single Window" tip="Enable if the API returns a single rate-limit object instead of an array of windows." />
                <Switch
                  checked={config.singleWindow ?? false}
                  onCheckedChange={(checked) => update({ singleWindow: checked })}
                />
              </div>

              {!config.singleWindow && (
                <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                  <FieldLabel label="Windows Path" tip={<>Dot-path to the array of rate-limit windows in the JSON response. For example, if the response is <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">{'{"data":{"limits":[...]}}'}</code>, use <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">data.limits</code>.</>} />
                  <DebouncedInput
                    className="font-mono text-xs"
                    placeholder="rate_limit.windows"
                    value={config.windowsPath ?? ''}
                    onValueCommit={(v) => update({ windowsPath: v })}
                  />
                </div>
              )}

              <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                <FieldLabel label="Label Field" tip={<>Dot-path to the field used as the display label for each window (e.g. <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">name</code> or <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">type</code>). Prefix with <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">=</code> for a literal value (e.g. <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">=5h</code>).</>} />
                <DebouncedInput
                  className="font-mono text-xs"
                  placeholder="name or =5h"
                  value={config.windowMapping.label}
                  onValueCommit={(v) => update({ windowMapping: { label: v } })}
                />
              </div>

              <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                <FieldLabel label="Label Renames" tip={<>Optional. Renames raw label values to friendlier display names. Format: <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">raw:display</code>, comma-separated. Example: <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">TIME_LIMIT:30d, TOKENS_LIMIT:5h</code></>} />
                <DebouncedInput
                  className="font-mono text-xs"
                  placeholder="TIME_LIMIT:30d, TOKENS_LIMIT:5h"
                  value={config.windowMapping.labelMap
                    ? Object.entries(config.windowMapping.labelMap).map(([k, v]) => `${k}:${v}`).join(', ')
                    : ''}
                  onValueCommit={(v) => {
                    if (!v.trim()) { update({ windowMapping: { labelMap: undefined } }); return }
                    const map: Record<string, string> = {}
                    for (const pair of v.split(',')) {
                      const [key, ...rest] = pair.split(':')
                      if (key?.trim() && rest.length) map[key.trim()] = rest.join(':').trim()
                    }
                    update({ windowMapping: { labelMap: Object.keys(map).length ? map : undefined } })
                  }}
                />
              </div>

              <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                <FieldLabel label="Utilization Field" tip="Dot-path to the percentage field (0-100) representing how much of the rate limit has been used." />
                <DebouncedInput
                  className="font-mono text-xs"
                  placeholder="utilization or used_percent"
                  value={config.windowMapping.utilization}
                  onValueCommit={(v) => update({ windowMapping: { utilization: v } })}
                />
              </div>

              <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                <FieldLabel label="Reset Time Field" tip="Dot-path to the timestamp when the rate-limit window resets. Select the matching format below." />
                <DebouncedInput
                  className="font-mono text-xs"
                  placeholder="resets_at or reset_at"
                  value={config.windowMapping.resetsAt}
                  onValueCommit={(v) => update({ windowMapping: { resetsAt: v } })}
                />
              </div>

              <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                <FieldLabel label="Time Format" tip={<><strong>ISO 8601</strong> — string like 2025-01-01T00:00:00Z.<br /><strong>Unix (seconds)</strong> — number like 1735689600.<br /><strong>Unix (ms)</strong> — number like 1735689600000.</>} />
                <Select
                  value={config.windowMapping.resetsAtFormat ?? 'iso'}
                  onValueChange={(v) => update({ windowMapping: { resetsAtFormat: v as 'iso' | 'unix-s' | 'unix-ms' } })}
                >
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="iso">ISO 8601</SelectItem>
                    <SelectItem value="unix-s">Unix (seconds)</SelectItem>
                    <SelectItem value="unix-ms">Unix (milliseconds)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Test */}
            <div className="flex items-center gap-3 pt-3 border-t border-border dark:border-border">
              <Button
                variant="outline"
                size="sm"
                disabled={testing || !config.url}
                onClick={handleTest}
              >
                {testing ? (
                  <RefreshCw className="size-3.5 mr-1.5 animate-spin" />
                ) : testResult?.ok ? (
                  <CheckCircle2 className="size-3.5 mr-1.5 text-green-500" />
                ) : testResult?.error ? (
                  <AlertCircle className="size-3.5 mr-1.5 text-destructive" />
                ) : (
                  <RefreshCw className="size-3.5 mr-1.5" />
                )}
                Test Connection
              </Button>
              {testResult && (
                <span className={`text-xs ${testResult.ok ? 'text-green-500' : 'text-destructive'}`}>
                  {testResult.ok
                    ? `Found ${testResult.windows?.length ?? 0} window(s)`
                    : testResult.error}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** Input that holds local state while typing and commits on blur. */
function DebouncedInput({ value: propValue, onValueCommit, ...props }: Omit<ComponentProps<typeof Input>, 'value' | 'onChange'> & { value: string; onValueCommit: (value: string) => void }) {
  const [localValue, setLocalValue] = useState(propValue)
  const committedRef = useRef(propValue)

  useEffect(() => {
    // Sync from props only when external value changes (not from our own commit)
    if (propValue !== committedRef.current) {
      committedRef.current = propValue
      setLocalValue(propValue)
    }
  }, [propValue])

  return (
    <Input
      {...props}
      value={localValue}
      onChange={(e) => setLocalValue(e.target.value)}
      onBlur={() => {
        if (localValue !== committedRef.current) {
          committedRef.current = localValue
          onValueCommit(localValue)
        }
      }}
    />
  )
}

interface AiProvidersSettingsTabProps {
  activeTab: string
  navigateTo: (tab: string) => void
  modes: TerminalModeInfo[]
  createMode: (input: CreateTerminalModeInput) => Promise<TerminalModeInfo>
  updateMode: (id: string, updates: UpdateTerminalModeInput) => Promise<TerminalModeInfo | null>
  deleteMode: (id: string) => Promise<boolean>
  testMode: (command: string) => Promise<{ ok: boolean; error?: string; detail?: string }>
  restoreDefaults: () => Promise<void>
  resetToDefaultState: () => Promise<void>
  defaultTerminalMode: TerminalMode
  onDefaultTerminalModeChange: (mode: TerminalMode) => void
}

export function AiProvidersSettingsTab(props: AiProvidersSettingsTabProps) {
  const {
    activeTab, navigateTo, modes, createMode, updateMode, deleteMode, testMode, restoreDefaults, resetToDefaultState, defaultTerminalMode, onDefaultTerminalModeChange,
  } = props

  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; error?: string; detail?: string }>>({})
  const [testingId, setTestingId] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)

  // New mode state encapsulated inside the tab
  const [newModeLabel, setNewModeLabel] = useState('')
  const [newInitialCommand, setNewInitialCommand] = useState('')
  const [newResumeCommand, setNewResumeCommand] = useState('')
  const [newDefaultFlags, setNewDefaultFlags] = useState('')
  const [newDetectionEngine, setNewDetectionEngine] = useState('terminal')
  const [newPatternWorking, setNewPatternWorking] = useState('')
  const [newPatternError, setNewPatternError] = useState('')

  const slugify = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

  const duplicateMode = (mode: TerminalModeInfo) => {
    setNewModeLabel(`${mode.label} (Copy)`)
    setNewInitialCommand(mode.initialCommand || '')
    setNewResumeCommand(mode.resumeCommand || '')
    setNewDefaultFlags(mode.defaultFlags || '')
    setNewDetectionEngine(mode.type || 'terminal')
    setNewPatternWorking(mode.patternWorking || '')
    setNewPatternError(mode.patternError || '')
    setShowAddForm(true)
  }

  const isValidRegex = (pattern: string) => {
    try {
      new RegExp(pattern)
      return true
    } catch {
      return false
    }
  }

  const handleTest = async (id: string, command: string) => {
    if (!command) {
      toast.error('Enter a command to test')
      return
    }
    setTestingId(id)
    try {
      const res = await testMode(command)
      setTestResults(prev => ({ ...prev, [id]: res }))
      if (res.ok) {
        toast.success(`Command "${command}" is valid`)
      } else {
        toast.error(`Command "${command}" failed: ${res.error}`)
      }
    } finally {
      setTestingId(null)
    }
  }

  return (
    <>
      <SettingsTabIntro
        title="Providers"
        description="Configure AI coding assistants and custom terminal modes. Each provider can have its own root command and default flags."
      />

      {activeTab === 'ai-providers' && (
        <div className="space-y-6">
          <div className="space-y-3">
            <Label className="text-sm font-medium">Default provider</Label>
            <Select value={defaultTerminalMode} onValueChange={(v) => onDefaultTerminalModeChange(v as TerminalMode)}>
              <SelectTrigger className="max-w-sm"><SelectValue /></SelectTrigger>
              <SelectContent position="popper" align="start" className="min-w-[var(--radix-select-trigger-width)] max-h-none">
                {(() => {
                  const visibleModes = getVisibleModes(modes, defaultTerminalMode)
                  const { builtin, custom } = groupTerminalModes(visibleModes)
                  return (
                    <>
                      {builtin.map(m => <SelectItem key={m.id} value={m.id}>{getModeLabel(m)}</SelectItem>)}
                      {custom.length > 0 && builtin.length > 0 && <SelectSeparator />}
                      {custom.map(m => <SelectItem key={m.id} value={m.id}>{getModeLabel(m)}</SelectItem>)}
                    </>
                  )
                })()}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <Label className="text-base font-semibold">Providers</Label>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={restoreDefaults}>
                Restore defaults
              </Button>
              <Button variant="outline" size="sm" onClick={resetToDefaultState} className="text-destructive hover:text-destructive">
                Reset all
              </Button>
            </div>
          </div>

          <div className="space-y-6">
            {(() => {
              const { builtin, custom } = groupTerminalModes(modes)
              return (
                <>
                  {builtin.length > 0 && (
                    <div className="space-y-3">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Built-in</h4>
                      <div className="space-y-2">
                        {builtin.map((mode) => (
                          <button
                            key={mode.id}
                            type="button"
                            className="flex items-center gap-3 h-11 rounded-lg border px-4 w-full text-left hover:bg-accent/30 transition-colors"
                            onClick={() => navigateTo(`ai-providers/${mode.id}`)}
                          >
                            <div className="size-4 flex items-center justify-center shrink-0">
                               <div className="size-2 rounded-full bg-blue-500" />
                            </div>
                            <span className="text-sm font-medium flex-1">{mode.label}</span>
                            <span className="text-xs text-muted-foreground truncate max-w-[200px] font-mono">{mode.initialCommand}</span>
                            <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                              <Label htmlFor={`list-enable-${mode.id}`} className="text-[10px] uppercase text-muted-foreground font-semibold cursor-pointer">Enabled</Label>
                              <Switch
                                id={`list-enable-${mode.id}`}
                                checked={mode.enabled}
                                onCheckedChange={(checked) => updateMode(mode.id, { enabled: checked })}
                              />
                            </div>
                            <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {custom.length > 0 && (
                    <div className="space-y-3 pt-4 border-t border-border dark:border-border">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Custom</h4>
                      <div className="space-y-2">
                        {custom.map((mode) => (
                          <button
                            key={mode.id}
                            type="button"
                            className="flex items-center gap-3 h-11 rounded-lg border px-4 w-full text-left hover:bg-accent/30 transition-colors"
                            onClick={() => navigateTo(`ai-providers/${mode.id}`)}
                          >
                            <div className="size-4 flex items-center justify-center shrink-0">
                               <div className="size-2 rounded-full bg-blue-500" />
                            </div>
                            <span className="text-sm font-medium flex-1">{mode.label}</span>
                            <span className="text-xs text-muted-foreground truncate max-w-[200px] font-mono">{mode.initialCommand}</span>
                            <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                              <Label htmlFor={`list-enable-${mode.id}`} className="text-[10px] uppercase text-muted-foreground font-semibold cursor-pointer">Enabled</Label>
                              <Switch
                                id={`list-enable-${mode.id}`}
                                checked={mode.enabled}
                                onCheckedChange={(checked) => updateMode(mode.id, { enabled: checked })}
                              />
                            </div>
                            <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )
            })()}
          </div>

          {!showAddForm ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1 border-dashed"
                onClick={() => setShowAddForm(true)}
              >
                <Plus className="size-3.5 mr-1.5" />
                Add Custom Provider
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="flex-1 border-dashed">
                    <Copy className="size-3.5 mr-1.5" />
                    Duplicate Provider
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {(() => {
                    const builtin = modes.filter(m => m.isBuiltin && m.id !== 'terminal')
                    const custom = modes.filter(m => !m.isBuiltin)
                    return (
                      <>
                        <DropdownMenuLabel className="text-xs text-muted-foreground">Built-in</DropdownMenuLabel>
                        {builtin.map(mode => (
                          <DropdownMenuItem key={mode.id} onClick={() => duplicateMode(mode)}>
                            {mode.label}
                          </DropdownMenuItem>
                        ))}
                        {custom.length > 0 && (
                          <>
                            <DropdownMenuLabel className="text-xs text-muted-foreground mt-4">Custom</DropdownMenuLabel>
                            {custom.map(mode => (
                              <DropdownMenuItem key={mode.id} onClick={() => duplicateMode(mode)}>
                                {mode.label}
                              </DropdownMenuItem>
                            ))}
                          </>
                        )}
                      </>
                    )
                  })()}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : (
            <div className="p-4 rounded-lg border border-dashed space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold">Add Custom Provider</h4>
                <Button variant="ghost" size="sm" onClick={() => setShowAddForm(false)}>Cancel</Button>
              </div>
              <div className="space-y-2">
                <Label className="text-xs uppercase text-muted-foreground">Label</Label>
                <Input
                  placeholder="My AI"
                  value={newModeLabel}
                  onChange={(e) => setNewModeLabel(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs uppercase text-muted-foreground">Initial Command</Label>
                <div className="flex items-center gap-2">
                  <Input
                    className="font-mono text-xs flex-1"
                    placeholder="e.g. my-cli {flags}"
                    value={newInitialCommand}
                    onChange={(e) => {
                      setNewInitialCommand(e.target.value)
                      if (testResults['__new__']) setTestResults(prev => { const n = { ...prev }; delete n['__new__']; return n })
                    }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9"
                    disabled={testingId === '__new__'}
                    onClick={() => handleTest('__new__', newInitialCommand.split(/\s+/)[0] || '')}
                  >
                    {testingId === '__new__' ? (
                      <RefreshCw className="size-3.5 mr-1.5 animate-spin" />
                    ) : testResults['__new__']?.ok ? (
                      <CheckCircle2 className="size-3.5 mr-1.5 text-green-500" />
                    ) : testResults['__new__']?.error ? (
                      <AlertCircle className="size-3.5 mr-1.5 text-destructive" />
                    ) : (
                      <RefreshCw className="size-3.5 mr-1.5" />
                    )}
                    Test
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Use <code className="px-1 bg-muted rounded">{'{flags}'}</code> for task flags and <code className="px-1 bg-muted rounded">{'{id}'}</code> for session ID.
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-xs uppercase text-muted-foreground">Resume Command</Label>
                <Input
                  className="font-mono text-xs"
                  placeholder="e.g. my-cli {flags} --resume {id}"
                  value={newResumeCommand}
                  onChange={(e) => setNewResumeCommand(e.target.value)}
                />
                <p className="text-[10px] text-muted-foreground">
                  Optional. Template for resuming sessions. Same variables as above.
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-xs uppercase text-muted-foreground">Default Flags</Label>
                <Input
                  className="font-mono text-xs"
                  placeholder="--json --verbose"
                  value={newDefaultFlags}
                  onChange={(e) => setNewDefaultFlags(e.target.value)}
                />
                <p className="text-[10px] text-muted-foreground">
                  Default value for <code className="px-1 bg-muted rounded">{'{flags}'}</code>. Editable per task.
                </p>
              </div>

              <div className="pt-2 border-t border-dashed border-border dark:border-border space-y-3">
                <h5 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Status Detection</h5>
                <div className="space-y-2">
                  <Label className="text-[10px] uppercase text-muted-foreground">Detection Engine</Label>
                  <Select value={newDetectionEngine} onValueChange={setNewDetectionEngine}>
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DETECTION_ENGINES.map(e => (
                        <SelectItem key={e.type} value={e.type}>{e.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {newDetectionEngine === 'terminal' && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-[10px] uppercase text-muted-foreground">Working</Label>
                      <Input
                        className="h-8 text-xs font-mono"
                        placeholder="e.g. \.\.\."
                        value={newPatternWorking}
                        onChange={(e) => setNewPatternWorking(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px] uppercase text-muted-foreground">Error</Label>
                      <Input
                        className="h-8 text-xs font-mono"
                        placeholder="e.g. fail"
                        value={newPatternError}
                        onChange={(e) => setNewPatternError(e.target.value)}
                      />
                    </div>
                  </div>
                )}
              </div>

              <Button
                size="sm"
                className="w-full"
                disabled={!newModeLabel || !newInitialCommand}
                onClick={() => {
                  const generatedId = `${slugify(newModeLabel)}-${Math.random().toString(36).substring(2, 7)}`
                  createMode({
                    id: generatedId,
                    label: newModeLabel,
                    type: newDetectionEngine,
                    initialCommand: newInitialCommand,
                    resumeCommand: newResumeCommand || null,
                    defaultFlags: newDefaultFlags || null,
                    enabled: true,
                    patternWorking: newPatternWorking || null,
                    patternError: newPatternError || null,
                  }).then(() => {
                    setNewModeLabel('')
                    setNewInitialCommand('')
                    setNewResumeCommand('')
                    setNewDefaultFlags('')
                    setNewDetectionEngine('terminal')
                    setNewPatternWorking('')
                    setNewPatternError('')
                    setShowAddForm(false)
                    toast.success(`Provider "${newModeLabel}" added`)
                  }).catch(err => {
                    toast.error(err.message)
                  })
                }}
              >
                <Plus className="size-3.5 mr-1" />
                Add Provider
              </Button>
            </div>
          )}
        </div>
      )}

      {activeTab.startsWith('ai-providers/') && (() => {
        const modeId = activeTab.split('/')[1]
        const mode = modes.find(m => m.id === modeId)
        if (!mode) return null
        return (
          <div className="space-y-6">
            <PanelBreadcrumb label={mode.label} onBack={() => navigateTo('ai-providers')} parentLabel="Providers" />
            <div className="rounded-lg border p-5 space-y-6">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <h3 className="text-base font-semibold">{mode.label}</h3>
                  <p className="text-sm text-muted-foreground">
                    {mode.isBuiltin 
                      ? 'This is a built-in provider. You can only customize its default flags and enabled state.'
                      : 'Configure settings for this custom provider.'}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Label htmlFor={`enable-${mode.id}`} className="text-xs font-medium cursor-pointer">Enabled</Label>
                    <Switch
                      id={`enable-${mode.id}`}
                      checked={mode.enabled}
                      onCheckedChange={(checked) => updateMode(mode.id, { enabled: checked })}
                    />
                  </div>
                  {!mode.isBuiltin && (
                    <IconButton
                      variant="ghost"
                      aria-label="Delete provider"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        if (window.confirm(`Are you sure you want to remove "${mode.label}"?`)) {
                          deleteMode(mode.id).then(() => navigateTo('ai-providers'))
                        }
                      }}
                    >
                      <Trash2 className="size-4" />
                    </IconButton>
                  )}
                </div>
              </div>

              <div className="space-y-4">
                <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                  <Label className={`text-sm ${mode.isBuiltin ? 'text-muted-foreground' : ''}`}>Label</Label>
                  {mode.isBuiltin ? (
                    <Input
                      value={mode.label}
                      readOnly
                      disabled
                      className="bg-muted/50 cursor-not-allowed opacity-70"
                    />
                  ) : (
                    <DebouncedInput
                      value={mode.label}
                      onValueCommit={(v) => updateMode(mode.id, { label: v })}
                    />
                  )}
                </div>
                <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-4">
                  <div className="space-y-0.5 pt-2">
                    <Label className={`text-sm ${mode.isBuiltin ? 'text-muted-foreground' : ''}`}>Initial Command</Label>
                    {!mode.isBuiltin && <p className="text-[10px] text-muted-foreground">Run on first launch</p>}
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      {mode.isBuiltin ? (
                        <Input
                          className="font-mono text-xs flex-1 bg-muted/50 cursor-not-allowed opacity-70"
                          value={mode.initialCommand ?? ''}
                          readOnly
                          disabled
                        />
                      ) : (
                        <DebouncedInput
                          className="font-mono text-xs flex-1"
                          value={mode.initialCommand ?? ''}
                          onValueCommit={(v) => {
                            updateMode(mode.id, { initialCommand: v })
                            if (testResults[mode.id]) setTestResults(prev => { const n = { ...prev }; delete n[mode.id]; return n })
                          }}
                        />
                      )}
                      {!mode.isBuiltin && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-9"
                          aria-label="Test command"
                          disabled={testingId === mode.id || !mode.initialCommand}
                          onClick={() => handleTest(mode.id, (mode.initialCommand ?? '').split(/\s+/)[0] || '')}
                        >
                          {testingId === mode.id ? (
                            <RefreshCw className="size-3.5 mr-1.5 animate-spin" />
                          ) : testResults[mode.id]?.ok ? (
                            <CheckCircle2 className="size-3.5 mr-1.5 text-green-500" />
                          ) : testResults[mode.id]?.error ? (
                            <AlertCircle className="size-3.5 mr-1.5 text-destructive" />
                          ) : (
                            <RefreshCw className="size-3.5 mr-1.5" />
                          )}
                          Test
                        </Button>
                      )}
                    </div>
                    {!mode.isBuiltin && (
                      <p className="text-[10px] text-muted-foreground">
                        Use <code className="px-1 bg-muted rounded">{'{flags}'}</code> for task flags and <code className="px-1 bg-muted rounded">{'{id}'}</code> for session ID.
                      </p>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-4">
                  <div className="space-y-0.5 pt-2">
                    <Label className={`text-sm ${mode.isBuiltin ? 'text-muted-foreground' : ''}`}>Resume Command</Label>
                    {!mode.isBuiltin && <p className="text-[10px] text-muted-foreground">Run when session exists</p>}
                  </div>
                  <div className="space-y-1">
                    {mode.isBuiltin ? (
                      <Input
                        className="font-mono text-xs bg-muted/50 cursor-not-allowed opacity-70"
                        value={mode.resumeCommand ?? ''}
                        readOnly
                        disabled
                      />
                    ) : (
                      <DebouncedInput
                        className="font-mono text-xs"
                        placeholder="e.g. my-cli {flags} --resume {id}"
                        value={mode.resumeCommand ?? ''}
                        onValueCommit={(v) => updateMode(mode.id, { resumeCommand: v || null })}
                      />
                    )}
                    {!mode.isBuiltin && (
                      <p className="text-[10px] text-muted-foreground">
                        Optional. Same variables as initial command.
                      </p>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-4">
                  <div className="space-y-0.5 pt-2">
                    <Label className={`text-sm ${mode.isBuiltin ? 'text-muted-foreground' : ''}`}>Headless Command</Label>
                    {!mode.isBuiltin && <p className="text-[10px] text-muted-foreground">Run for one-shot AI actions</p>}
                  </div>
                  <div className="space-y-1">
                    {mode.isBuiltin ? (
                      <Input
                        className="font-mono text-xs bg-muted/50 cursor-not-allowed opacity-70"
                        value={mode.headlessCommand ?? ''}
                        readOnly
                        disabled
                      />
                    ) : (
                      <DebouncedInput
                        className="font-mono text-xs"
                        placeholder="e.g. my-cli -p {prompt} {flags}"
                        value={mode.headlessCommand ?? ''}
                        onValueCommit={(v) => updateMode(mode.id, { headlessCommand: v || null })}
                      />
                    )}
                    <p className="text-[10px] text-muted-foreground">
                      Optional. Use <code className="px-1 bg-muted rounded">{'{prompt}'}</code> (auto-quoted) and <code className="px-1 bg-muted rounded">{'{flags}'}</code>. Required to use this provider in automation AI actions.
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                  <Label className="text-sm">Default Flags</Label>
                  <div className="space-y-1">
                    <DebouncedInput
                      className="font-mono text-xs"
                      value={mode.defaultFlags ?? ''}
                      onValueCommit={(v) => updateMode(mode.id, { defaultFlags: v })}
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Default value for <code className="px-1 bg-muted rounded">{'{flags}'}</code>. Editable per task.
                    </p>
                  </div>
                </div>

                {!mode.isBuiltin && (
                  <div className="pt-4 border-t border-border dark:border-border">
                    <div className="rounded-xl border bg-surface-2/50 dark:bg-surface-0/30 p-5 space-y-4">
                      <div className="space-y-1">
                        <h4 className="text-sm font-semibold">Status Detection</h4>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          Controls how the terminal state (working, error) is detected from output.
                        </p>
                      </div>

                      <div className="space-y-4 pt-2">
                        <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                          <Label className="text-xs font-medium">Detection Engine</Label>
                          <Select value={mode.type} onValueChange={(v) => updateMode(mode.id, { type: v })}>
                            <SelectTrigger size="sm" className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {DETECTION_ENGINES.map(e => (
                                <SelectItem key={e.type} value={e.type}>{e.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        {mode.type === 'terminal' && (
                          <>
                            <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                              <div className="space-y-0.5">
                                <Label className="text-xs font-medium">Working Pattern</Label>
                                <p className="text-[10px] text-muted-foreground">Thinking/Processing</p>
                              </div>
                              <div className="space-y-1">
                                <DebouncedInput
                                  className="font-mono text-xs"
                                  placeholder="e.g. ⠋|⠙|⠹"
                                  value={mode.patternWorking ?? ''}
                                  onValueCommit={(v) => updateMode(mode.id, { patternWorking: v || null })}
                                />
                                {mode.patternWorking && !isValidRegex(mode.patternWorking) && (
                                  <p className="text-[10px] text-destructive">Invalid regular expression</p>
                                )}
                              </div>
                            </div>

                            <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                              <div className="space-y-0.5">
                                <Label className="text-xs font-medium">Error Pattern</Label>
                                <p className="text-[10px] text-muted-foreground">Fatal/CLI errors</p>
                              </div>
                              <div className="space-y-1">
                                <DebouncedInput
                                  className="font-mono text-xs"
                                  placeholder="e.g. ^Error:.*"
                                  value={mode.patternError ?? ''}
                                  onValueCommit={(v) => updateMode(mode.id, { patternError: v || null })}
                                />
                                {mode.patternError && !isValidRegex(mode.patternError) && (
                                  <p className="text-[10px] text-destructive">Invalid regular expression</p>
                                )}
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <UsageConfigSection mode={mode} onUpdate={updateMode} />
            </div>
          </div>
        )
      })()}
    </>
  )
}
