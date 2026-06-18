import { useCallback, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import * as Collapsible from '@radix-ui/react-collapsible'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  shortcutDefinitions,
  useShortcutStore,
  type ShortcutDefinition
} from '@slayzone/ui'
import { ShortcutRow } from './ShortcutRow'
import type { KeyRecorderComponent } from './types'

export function ShortcutsDialog({
  open,
  onOpenChange,
  keyRecorder: KeyRecorder
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** App injects its `KeyRecorder`; renderless hotkey capture while recording. */
  keyRecorder: KeyRecorderComponent
}) {
  const [openShortcutGroup, setOpenShortcutGroup] = useState<string | null>(
    () => shortcutDefinitions[0]?.group ?? null
  )
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [pendingKeys, setPendingKeys] = useState<string | null>(null)
  const [pendingConflict, setPendingConflict] = useState<ShortcutDefinition | null>(null)
  const [shadowWarning, setShadowWarning] = useState<{
    defId: string
    shadow: ShortcutDefinition
  } | null>(null)

  const overrides = useShortcutStore((s) => s.overrides)
  const {
    getKeys,
    findConflict,
    findShadow,
    setOverride,
    batchSetOverrides,
    resetAll,
    setRecording
  } = useShortcutStore()

  const effectiveKeysMap = useMemo(() => {
    const map: Record<string, string | null> = {}
    for (const def of shortcutDefinitions) {
      map[def.id] = def.id in overrides ? overrides[def.id] : def.defaultKeys
    }
    return map
  }, [overrides])

  const shortcutGroups = useMemo(() => {
    const groups: { heading: string; items: ShortcutDefinition[] }[] = []
    for (const def of shortcutDefinitions) {
      let group = groups.find((g) => g.heading === def.group)
      if (!group) {
        group = { heading: def.group, items: [] }
        groups.push(group)
      }
      group.items.push(def)
    }
    return groups
  }, [])

  const handleCapture = useCallback(
    (keys: string) => {
      if (!recordingId) return
      const def = shortcutDefinitions.find((d) => d.id === recordingId)
      if (!def) return

      const conflict = findConflict(keys, def.scope)
      if (conflict && conflict.id !== recordingId) {
        setPendingKeys(keys)
        setPendingConflict(conflict)
        return
      }

      const shadow = findShadow(keys, def.scope)

      setOverride(recordingId, keys)
      setRecording(false)
      setPendingKeys(null)
      setPendingConflict(null)

      if (shadow && shadow.id !== recordingId) {
        setShadowWarning({ defId: recordingId, shadow })
        setRecordingId(null)
      } else {
        setRecordingId(null)
      }
    },
    [recordingId, findConflict, findShadow, setOverride, setRecording]
  )

  const handleCancelRecording = useCallback(() => {
    setRecordingId(null)
    setRecording(false)
    setPendingKeys(null)
    setPendingConflict(null)
    setShadowWarning(null)
  }, [setRecording])

  const handleConfirmReassign = useCallback(async () => {
    if (!recordingId || !pendingKeys || !pendingConflict) return
    const previousKeys = getKeys(recordingId)
    await batchSetOverrides({ [pendingConflict.id]: previousKeys, [recordingId]: pendingKeys })
    setRecordingId(null)
    setRecording(false)
    setPendingKeys(null)
    setPendingConflict(null)
  }, [recordingId, pendingKeys, pendingConflict, getKeys, batchSetOverrides, setRecording])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) handleCancelRecording()
      }}
    >
      <DialogContent className="max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
          <DialogDescription className="sr-only">List of keyboard shortcuts</DialogDescription>
        </DialogHeader>
        <KeyRecorder
          active={recordingId !== null && !pendingConflict}
          onCapture={handleCapture}
          onCancel={handleCancelRecording}
        />
        <div className="space-y-1 overflow-y-auto scrollbar-thin">
          {shortcutGroups.map((group) => (
            <Collapsible.Root
              key={group.heading}
              open={openShortcutGroup === group.heading}
              onOpenChange={(open) => setOpenShortcutGroup(open ? group.heading : null)}
            >
              <Collapsible.Trigger className="flex w-full items-center justify-between px-3 py-2 rounded-lg bg-muted hover:bg-accent hover:text-accent-foreground transition-colors group/trigger">
                <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
                  {group.heading}
                </p>
                <ChevronDown className="size-3.5 text-muted-foreground transition-transform duration-200 group-data-[state=open]/trigger:rotate-180" />
              </Collapsible.Trigger>
              <Collapsible.Content className="data-[state=closed]:hidden">
                <div className="rounded-lg border divide-y mb-3">
                  {group.items.map((def) => (
                    <ShortcutRow
                      key={def.id}
                      def={def}
                      effectiveKeys={effectiveKeysMap[def.id]}
                      isRecordingThis={recordingId === def.id}
                      onStartRecording={() => {
                        handleCancelRecording()
                        setRecordingId(def.id)
                        setRecording(true)
                      }}
                      onCancelRecording={handleCancelRecording}
                      onClear={() => setOverride(def.id, '')}
                      conflictAction={recordingId === def.id ? pendingConflict : null}
                      shadowAction={shadowWarning?.defId === def.id ? shadowWarning.shadow : null}
                      onConfirmReassign={handleConfirmReassign}
                      onCancelConflict={handleCancelRecording}
                      onDismissShadow={() => setShadowWarning(null)}
                    />
                  ))}
                </div>
              </Collapsible.Content>
            </Collapsible.Root>
          ))}
        </div>
        <div className="flex justify-center pt-2 pb-1">
          <button
            type="button"
            onClick={resetAll}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Reset to Defaults
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
