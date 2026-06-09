import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { HelpCircle, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react'
import {
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  toast
} from '@slayzone/ui'
import type {
  TerminalModeInfo,
  UpdateTerminalModeInput,
  UsageProviderConfig,
  UsageWindow
} from '@slayzone/terminal/shared'
import { DebouncedInput } from './DebouncedInput'

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
  windowMapping: { label: 'name', utilization: 'utilization', resetsAt: 'resets_at' }
}

export function UsageConfigSection({
  mode,
  onUpdate
}: {
  mode: TerminalModeInfo
  onUpdate: (id: string, updates: UpdateTerminalModeInput) => Promise<TerminalModeInfo | null>
}) {
  const trpc = useTRPC()
  const usageTestMutation = useMutation(trpc.app.usage.test.mutationOptions())
  const config: UsageProviderConfig = mode.usageConfig ?? EMPTY_USAGE_CONFIG
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{
    ok: boolean
    windows?: UsageWindow[]
    error?: string
  } | null>(null)

  const update = (
    patch: Partial<Omit<UsageProviderConfig, 'windowMapping'>> & {
      windowMapping?: Partial<UsageProviderConfig['windowMapping']>
    }
  ) => {
    onUpdate(mode.id, {
      usageConfig: {
        ...config,
        ...patch,
        windowMapping: { ...config.windowMapping, ...patch.windowMapping }
      }
    })
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await usageTestMutation.mutateAsync(config)
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
              <FieldLabel
                label="URL"
                tip="The API endpoint that returns rate-limit or quota data. Must return JSON."
              />
              <div className="flex items-center gap-2">
                <Select
                  value={config.method || 'GET'}
                  onValueChange={(v) => update({ method: v as 'GET' | 'POST' })}
                >
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
              <FieldLabel
                label="Auth Type"
                tip={
                  <>
                    <strong>None</strong> — no auth header sent.
                    <br />
                    <strong>Env Variable</strong> — reads a token from an environment variable.
                    <br />
                    <strong>JSON File</strong> — reads a token from a JSON file on disk (e.g.
                    ~/.my-cli/auth.json).
                    <br />
                    <strong>Keychain</strong> — reads a token from the macOS Keychain.
                  </>
                }
              />
              <Select
                value={config.authType}
                onValueChange={(v) => update({ authType: v as UsageProviderConfig['authType'] })}
              >
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
                <FieldLabel
                  label="Env Var Name"
                  tip="Name of the environment variable that holds your API token. The app reads it from its own process environment."
                />
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
                  <FieldLabel
                    label="File Path"
                    tip="Absolute path to a JSON file containing your auth token. Use ~ for your home directory."
                  />
                  <DebouncedInput
                    className="font-mono text-xs"
                    placeholder="~/.my-cli/auth.json"
                    value={config.authFilePath ?? ''}
                    onValueCommit={(v) => update({ authFilePath: v })}
                  />
                </div>
                <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                  <FieldLabel
                    label="Token Path"
                    tip={
                      <>
                        Dot-path to the token inside the JSON file. For example, if the file is{' '}
                        <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">
                          {'{"tokens":{"key":"abc"}}'}
                        </code>
                        , use{' '}
                        <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">
                          tokens.key
                        </code>
                        .<br />
                        <br />
                        Comma-separate multiple paths to try them in order (first match wins).
                      </>
                    }
                  />
                  <DebouncedInput
                    className="font-mono text-xs"
                    placeholder="tokens.access_token"
                    value={
                      Array.isArray(config.authFileTokenPath)
                        ? config.authFileTokenPath.join(', ')
                        : (config.authFileTokenPath ?? '')
                    }
                    onValueCommit={(v) => {
                      const paths = v
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean)
                      update({ authFileTokenPath: paths.length > 1 ? paths : (paths[0] ?? '') })
                    }}
                  />
                </div>
              </>
            )}

            {/* Auth: Keychain */}
            {config.authType === 'keychain' && (
              <>
                <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                  <FieldLabel
                    label="Service Name"
                    tip="The macOS Keychain service name, e.g. Claude Code-credentials-<suffix> where <suffix> is the SHA-256 hash prefix of the instance path."
                  />
                  <DebouncedInput
                    className="font-mono text-xs"
                    placeholder="Claude Code-credentials-9f09856a"
                    value={config.authKeychainService ?? ''}
                    onValueCommit={(v) => update({ authKeychainService: v })}
                  />
                </div>
                <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                  <FieldLabel
                    label="Token Path"
                    tip={
                      <>
                        Dot-path to the token inside the Keychain JSON value. For Claude OAuth, use{' '}
                        <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">
                          claudeAiOauth.accessToken
                        </code>
                        . Leave empty if the value is the token itself.
                      </>
                    }
                  />
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
                  <FieldLabel
                    label="Header Name"
                    tip="The HTTP header name used to send the token. Defaults to Authorization if left empty."
                  />
                  <DebouncedInput
                    className="font-mono text-xs"
                    placeholder="Authorization"
                    value={config.authHeaderName ?? ''}
                    onValueCommit={(v) => update({ authHeaderName: v })}
                  />
                </div>
                <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                  <FieldLabel
                    label="Header Template"
                    tip={
                      <>
                        Template for the header value.{' '}
                        <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">
                          {'{token}'}
                        </code>{' '}
                        is replaced with the resolved token. Defaults to{' '}
                        <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">
                          Bearer {'{token}'}
                        </code>
                        .
                      </>
                    }
                  />
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
                <FieldLabel
                  label="Extra Headers"
                  tip={
                    <>
                      Additional HTTP headers as{' '}
                      <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">
                        key: value
                      </code>{' '}
                      pairs, one per line. Example:{' '}
                      <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">
                        anthropic-beta: oauth-2025-04-20
                      </code>
                    </>
                  }
                />
                <DebouncedInput
                  className="font-mono text-xs"
                  placeholder="anthropic-beta: oauth-2025-04-20"
                  value={
                    config.extraHeaders
                      ? Object.entries(config.extraHeaders)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join('\n')
                      : ''
                  }
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
                <h5 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Response Mapping
                </h5>
                <HelpTip>
                  Configure how to extract rate-limit windows from the API's JSON response. Each
                  window becomes a usage bar.
                </HelpTip>
              </div>

              <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                <FieldLabel
                  label="Single Window"
                  tip="Enable if the API returns a single rate-limit object instead of an array of windows."
                />
                <Switch
                  checked={config.singleWindow ?? false}
                  onCheckedChange={(checked) => update({ singleWindow: checked })}
                />
              </div>

              {!config.singleWindow && (
                <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                  <FieldLabel
                    label="Windows Path"
                    tip={
                      <>
                        Dot-path to the array of rate-limit windows in the JSON response. For
                        example, if the response is{' '}
                        <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">
                          {'{"data":{"limits":[...]}}'}
                        </code>
                        , use{' '}
                        <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">
                          data.limits
                        </code>
                        .
                      </>
                    }
                  />
                  <DebouncedInput
                    className="font-mono text-xs"
                    placeholder="rate_limit.windows"
                    value={config.windowsPath ?? ''}
                    onValueCommit={(v) => update({ windowsPath: v })}
                  />
                </div>
              )}

              <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                <FieldLabel
                  label="Label Field"
                  tip={
                    <>
                      Dot-path to the field used as the display label for each window (e.g.{' '}
                      <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">name</code>{' '}
                      or{' '}
                      <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">type</code>
                      ). Prefix with{' '}
                      <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">=</code>{' '}
                      for a literal value (e.g.{' '}
                      <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">=5h</code>
                      ).
                    </>
                  }
                />
                <DebouncedInput
                  className="font-mono text-xs"
                  placeholder="name or =5h"
                  value={config.windowMapping.label}
                  onValueCommit={(v) => update({ windowMapping: { label: v } })}
                />
              </div>

              <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                <FieldLabel
                  label="Label Renames"
                  tip={
                    <>
                      Optional. Renames raw label values to friendlier display names. Format:{' '}
                      <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">
                        raw:display
                      </code>
                      , comma-separated. Example:{' '}
                      <code className="text-[10px] px-0.5 bg-white/20 rounded font-mono">
                        TIME_LIMIT:30d, TOKENS_LIMIT:5h
                      </code>
                    </>
                  }
                />
                <DebouncedInput
                  className="font-mono text-xs"
                  placeholder="TIME_LIMIT:30d, TOKENS_LIMIT:5h"
                  value={
                    config.windowMapping.labelMap
                      ? Object.entries(config.windowMapping.labelMap)
                          .map(([k, v]) => `${k}:${v}`)
                          .join(', ')
                      : ''
                  }
                  onValueCommit={(v) => {
                    if (!v.trim()) {
                      update({ windowMapping: { labelMap: undefined } })
                      return
                    }
                    const map: Record<string, string> = {}
                    for (const pair of v.split(',')) {
                      const [key, ...rest] = pair.split(':')
                      if (key?.trim() && rest.length) map[key.trim()] = rest.join(':').trim()
                    }
                    update({
                      windowMapping: { labelMap: Object.keys(map).length ? map : undefined }
                    })
                  }}
                />
              </div>

              <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                <FieldLabel
                  label="Utilization Field"
                  tip="Dot-path to the percentage field (0-100) representing how much of the rate limit has been used."
                />
                <DebouncedInput
                  className="font-mono text-xs"
                  placeholder="utilization or used_percent"
                  value={config.windowMapping.utilization}
                  onValueCommit={(v) => update({ windowMapping: { utilization: v } })}
                />
              </div>

              <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                <FieldLabel
                  label="Reset Time Field"
                  tip="Dot-path to the timestamp when the rate-limit window resets. Select the matching format below."
                />
                <DebouncedInput
                  className="font-mono text-xs"
                  placeholder="resets_at or reset_at"
                  value={config.windowMapping.resetsAt}
                  onValueCommit={(v) => update({ windowMapping: { resetsAt: v } })}
                />
              </div>

              <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                <FieldLabel
                  label="Time Format"
                  tip={
                    <>
                      <strong>ISO 8601</strong> — string like 2025-01-01T00:00:00Z.
                      <br />
                      <strong>Unix (seconds)</strong> — number like 1735689600.
                      <br />
                      <strong>Unix (ms)</strong> — number like 1735689600000.
                    </>
                  }
                />
                <Select
                  value={config.windowMapping.resetsAtFormat ?? 'iso'}
                  onValueChange={(v) =>
                    update({ windowMapping: { resetsAtFormat: v as 'iso' | 'unix-s' | 'unix-ms' } })
                  }
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
                <span
                  className={`text-xs ${testResult.ok ? 'text-green-500' : 'text-destructive'}`}
                >
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
