import { useEffect, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import {
  Button,
  cn,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@slayzone/ui'
import {
  parseVoiceSettings,
  TTS_CATALOG,
  ttsEntry,
  VOICE_SETTINGS_KEY,
  type TtsChoice,
  type VoiceSettings
} from '../shared'
import { VoiceEngineClient } from './engine-client'
import { useTRPCClient } from './trpc'
import { voiceSettingsChanged } from './useVoiceMode'

/**
 * Conversation mode's voice options, beside the mic toggle: which voice speaks, and
 * for a cloud voice this device's key (stored encrypted by the desktop app, never
 * shown again) and voice id. Changes restart a running session.
 */
export function VoiceSettingsPopover(): React.JSX.Element {
  const trpc = useTRPCClient()
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState<VoiceSettings | null>(null)
  const [keys, setKeys] = useState<Record<string, boolean>>({})
  const [keyDraft, setKeyDraft] = useState('')
  const [voiceDraft, setVoiceDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void trpc.settings.get
      .query({ key: VOICE_SETTINGS_KEY })
      .catch(() => null)
      .then((raw) => {
        if (cancelled) return
        const s = parseVoiceSettings(typeof raw === 'string' ? raw : null)
        setSettings(s)
        setVoiceDraft(s.elevenLabsVoiceId)
      })
    void VoiceEngineClient.keyStatus().then((k) => {
      if (!cancelled) setKeys(k)
    })
    return () => {
      cancelled = true
    }
  }, [open, trpc])

  const save = (patch: Partial<VoiceSettings>): void => {
    if (!settings) return
    const next = { ...settings, ...patch }
    setSettings(next)
    setError(null)
    trpc.settings.set
      .mutate({ key: VOICE_SETTINGS_KEY, value: JSON.stringify(next) })
      .then(voiceSettingsChanged)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }

  const storeKey = (provider: string, key: string): void => {
    setError(null)
    VoiceEngineClient.setKey(provider, key)
      .then(() => VoiceEngineClient.keyStatus())
      .then((k) => {
        setKeys(k)
        setKeyDraft('')
        voiceSettingsChanged()
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }

  const current = settings ? ttsEntry(settings.tts) : null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Voice settings"
                data-testid="voice-settings"
                className="flex items-center px-1 py-0.5 rounded-md transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                <SlidersHorizontal className="size-3" />
              </button>
            </PopoverTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">Voice settings</TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="end" className="w-72 space-y-3 text-xs">
        <div className="space-y-1">
          <div className="font-medium text-foreground">Voice</div>
          {TTS_CATALOG.map((entry) => (
            <button
              key={entry.id}
              type="button"
              disabled={!settings}
              onClick={() => save({ tts: entry.id as TtsChoice })}
              className={cn(
                'flex w-full items-center justify-between rounded-md px-2 py-1 text-left transition-colors',
                settings?.tts === entry.id
                  ? 'bg-primary/15 text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              )}
            >
              <span>{entry.label}</span>
              {entry.kind === 'cloud' && keys[entry.id] && (
                <span className="text-3xs text-muted-foreground">key set</span>
              )}
            </button>
          ))}
        </div>
        {current?.kind === 'cloud' && (
          <div className="space-y-2 border-t border-border pt-2">
            <div className="space-y-1">
              <div className="text-muted-foreground">
                API key {keys[current.id] ? '(stored on this device)' : '(not set)'}
              </div>
              <div className="flex gap-1">
                <Input
                  type="password"
                  autoComplete="off"
                  placeholder={keys[current.id] ? 'Replace key…' : current.keyHint}
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  className="h-7 text-xs"
                />
                <Button
                  size="sm"
                  className="h-7"
                  disabled={!keyDraft.trim()}
                  onClick={() => storeKey(current.id, keyDraft)}
                >
                  Save
                </Button>
                {keys[current.id] && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    onClick={() => storeKey(current.id, '')}
                  >
                    Clear
                  </Button>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-muted-foreground">Voice id (optional)</div>
              <Input
                placeholder="default voice"
                value={voiceDraft}
                onChange={(e) => setVoiceDraft(e.target.value)}
                onBlur={() => {
                  if (settings && voiceDraft.trim() !== settings.elevenLabsVoiceId) {
                    save({ elevenLabsVoiceId: voiceDraft.trim() })
                  }
                }}
                className="h-7 text-xs"
              />
            </div>
            <p className="text-3xs text-muted-foreground">
              Replies are sent to ElevenLabs to be spoken. Your speech stays on this device.
            </p>
          </div>
        )}
        {error && <p className="text-3xs text-destructive">{error}</p>}
      </PopoverContent>
    </Popover>
  )
}
