/**
 * The chat's permission mode, model and effort as three chips (desktop's chat pills);
 * a tap lists the choices in a sheet. The models are the hub's (`chat.getModels`);
 * effort shows only for a model that has it, with that model's own levels. The chips
 * scroll sideways when they don't fit; the choices open in the app's bottom sheet.
 *
 * `pill` (the phone's task page, in the composer): the model alone, as one pill — a
 * tap picks the model; a long press (VoiceOver: its actions) lists the permission mode,
 * effort and collaboration mode, each opening its choices in the same sheet.
 */
import type { ChatModelsView } from '@slayzone/terminal-contracts'
import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native'
import type { ChromeColors } from '../theme'
import { BottomSheet } from '../ui-kit/Chrome'
import {
  type ControlOption,
  effortLabel,
  effortOptions,
  modeLabel,
  modelChipLabel,
  modelOptions,
  modeOptions,
  unlistedModelsHint
} from './chat-controls'
import { useThemedStyles } from './styles'
import type { ChatSettings } from './useChatSettings'

type Picker = 'mode' | 'model' | 'effort' | 'collaboration'
/** What a long press on the pill opens: every control but the model, by name. */
type Opened = Picker | 'settings'

export function ChatControls({
  mode,
  settings,
  models,
  variant = 'chips'
}: {
  mode: string
  settings: ChatSettings
  models: ChatModelsView
  /** `chips`: the row of chips; `pill`: the model alone, the rest behind a long press. */
  variant?: 'chips' | 'pill'
}) {
  const { s } = useThemedStyles(makeStyles)
  const [picker, setPicker] = useState<Opened | null>(null)
  const showEffort = !!settings.model && models.supportsEffort(settings.model)
  const effortLevels = settings.model ? models.effortLevels(settings.model) : undefined

  const modeText = settings.mode ? modeLabel(settings.mode) : 'Mode'
  const modelText = modelChipLabel(models, settings.model)
  const effortText = effortLabel(settings.effort, effortLevels)
  const collaborationText = settings.collaboration === 'plan' ? 'Plan' : 'Default'
  /** The controls behind the pill's long press, in the chips' order (the model first). */
  const controls: Array<{ picker: Picker; label: string; value: string; busy: boolean }> = [
    { picker: 'model', label: 'Model', value: modelText, busy: settings.changing.model },
    { picker: 'mode', label: 'Permission mode', value: modeText, busy: settings.changing.mode },
    ...(showEffort
      ? [
          {
            picker: 'effort' as const,
            label: 'Effort',
            value: effortText,
            busy: settings.changing.effort
          }
        ]
      : []),
    ...(mode === 'codex-chat'
      ? [
          {
            picker: 'collaboration' as const,
            label: 'Collaboration mode',
            value: collaborationText,
            busy: settings.changing.collaboration
          }
        ]
      : [])
  ]

  const sheet: {
    title: string
    options: ControlOption[]
    /** Said when there is nothing to pick. */
    hint?: string
    value: string | null
    pick: (id: string) => void
  } | null =
    picker === 'mode'
      ? {
          title: 'Permission mode',
          options: modeOptions(mode, settings.autoEligible),
          value: settings.mode,
          pick: (id) => void settings.setMode(id).catch(() => undefined)
        }
      : picker === 'model'
        ? {
            title: 'Model',
            options: modelOptions(models),
            ...(models.unlisted ? { hint: unlistedModelsHint(mode) } : {}),
            value: settings.model,
            pick: (id) => void settings.setModel(id).catch(() => undefined)
          }
        : picker === 'effort'
          ? {
              title: 'Effort',
              options: effortOptions(effortLevels),
              value: settings.effort,
              pick: (id) => void settings.setEffort(id).catch(() => undefined)
            }
          : picker === 'collaboration'
            ? {
                title: 'Collaboration mode',
                options: [
                  { id: 'default', label: 'Default', description: 'Implement and edit' },
                  { id: 'plan', label: 'Plan', description: 'Explore and propose' }
                ],
                value: settings.collaboration,
                pick: (id) => void settings.setCollaboration(id).catch(() => undefined)
              }
            : null

  const choices = (
    <BottomSheet
      visible={picker !== null}
      onClose={() => setPicker(null)}
      testID="chat-control-sheet"
    >
      {picker === 'settings' ? (
        <>
          <Text style={s.sheetTitle}>Chat settings</Text>
          {controls.map((o) => (
            <Pressable
              key={o.picker}
              onPress={() => setPicker(o.picker)}
              style={s.settingRow}
              accessibilityRole="button"
              accessibilityLabel={o.label}
              accessibilityValue={{ text: o.value }}
            >
              <Text style={s.optionLabel}>{o.label}</Text>
              <Text style={s.settingValue} numberOfLines={1}>
                {o.value}
                {o.busy ? '…' : ''} ›
              </Text>
            </Pressable>
          ))}
        </>
      ) : null}
      {sheet && (
        <>
          <Text style={s.sheetTitle}>{sheet.title}</Text>
          {sheet.options.length === 0 && sheet.hint ? (
            <Text style={s.sheetHint}>{sheet.hint}</Text>
          ) : null}
          <ScrollView style={s.options}>
            {sheet.options.map((o) => (
              <Pressable
                key={o.id}
                onPress={() => {
                  setPicker(null)
                  sheet.pick(o.id)
                }}
                style={[s.option, o.id === sheet.value && s.optionOn]}
                accessibilityRole="radio"
                accessibilityState={{ checked: o.id === sheet.value }}
              >
                <Text style={s.optionLabel}>{o.label}</Text>
                {o.description ? <Text style={s.optionDescription}>{o.description}</Text> : null}
              </Pressable>
            ))}
          </ScrollView>
        </>
      )}
    </BottomSheet>
  )

  if (variant === 'pill') {
    const busy = controls.some((o) => o.busy)
    const actions = controls.filter((o) => o.picker !== 'model')
    return (
      <>
        <Pressable
          testID="chat-model-pill"
          onPress={() => setPicker('model')}
          onLongPress={() => setPicker('settings')}
          hitSlop={PILL_SLOP}
          style={[s.pill, busy && s.chipBusy]}
          accessibilityRole="button"
          accessibilityLabel={`Model: ${modelText}`}
          accessibilityHint="Long press for the permission mode and effort."
          accessibilityActions={[
            { name: 'activate' },
            ...actions.map((o) => ({ name: o.picker, label: o.label }))
          ]}
          onAccessibilityAction={(e) => {
            const name = e.nativeEvent.actionName
            const hit = actions.find((o) => o.picker === name)
            setPicker(hit ? hit.picker : 'model')
          }}
        >
          <Text style={s.pillText} numberOfLines={1} maxFontSizeMultiplier={PILL_MAX_SCALE}>
            {modelText}
            {busy ? '…' : ''} ▾
          </Text>
        </Pressable>
        {choices}
      </>
    )
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={s.scroller}
      contentContainerStyle={s.bar}
      keyboardShouldPersistTaps="handled"
      testID="chat-controls"
    >
      <Chip
        label={modeText}
        busy={settings.changing.mode}
        onPress={() => setPicker('mode')}
        a11y="Permission mode"
        s={s}
      />
      <Chip
        label={modelText}
        busy={settings.changing.model}
        onPress={() => setPicker('model')}
        a11y="Model"
        s={s}
      />
      {showEffort && (
        <Chip
          label={effortText}
          busy={settings.changing.effort}
          onPress={() => setPicker('effort')}
          a11y="Effort"
          s={s}
        />
      )}
      {mode === 'codex-chat' && (
        <Chip
          label={collaborationText}
          busy={settings.changing.collaboration}
          onPress={() => setPicker('collaboration')}
          a11y="Collaboration mode"
          s={s}
        />
      )}
      {choices}
    </ScrollView>
  )
}

type Styles = ReturnType<typeof makeStyles>

/** The pill (40pt tall, beside Send) reaches 44pt to a finger. */
const PILL_SLOP = { top: 2, bottom: 2, left: 2, right: 2 }
/** The pill's words grow with Dynamic Type, but not past what the composer's row holds. */
const PILL_MAX_SCALE = 1.3

function Chip({
  label,
  busy,
  onPress,
  a11y,
  s
}: {
  label: string
  busy: boolean
  onPress: () => void
  a11y: string
  s: Styles
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[s.chip, busy && s.chipBusy]}
      accessibilityRole="button"
      accessibilityLabel={`${a11y}: ${label}`}
    >
      <Text style={s.chipText} numberOfLines={1}>
        {label}
        {busy ? '…' : ''}
      </Text>
    </Pressable>
  )
}

function makeStyles(t: ChromeColors) {
  return StyleSheet.create({
    scroller: { flexGrow: 0, flexShrink: 0 },
    bar: { flexDirection: 'row', gap: 6, paddingHorizontal: 8, paddingTop: 6 },
    chip: {
      minHeight: 32,
      justifyContent: 'center',
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      backgroundColor: t.surface1,
      maxWidth: 170
    },
    chipBusy: { opacity: 0.6 },
    pill: {
      height: 40,
      maxWidth: 120,
      justifyContent: 'center',
      paddingHorizontal: 12,
      borderRadius: 20,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      backgroundColor: t.surface2
    },
    pillText: { color: t.foreground, fontSize: 13, fontWeight: '600' },
    settingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      minHeight: 48,
      paddingVertical: 12,
      paddingHorizontal: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border
    },
    settingValue: { flexShrink: 1, color: t.mutedForeground, fontSize: 15 },
    chipText: { color: t.foreground, fontSize: 12, fontWeight: '600' },
    options: { maxHeight: 420 },
    sheetTitle: { color: t.popoverForeground, fontSize: 15, fontWeight: '700', marginBottom: 8 },
    sheetHint: { color: t.mutedForeground, fontSize: 13, paddingHorizontal: 10, paddingBottom: 8 },
    option: { paddingVertical: 10, paddingHorizontal: 10, borderRadius: 8 },
    optionOn: { backgroundColor: t.accent },
    optionLabel: { color: t.popoverForeground, fontSize: 15, fontWeight: '600' },
    optionDescription: { color: t.mutedForeground, fontSize: 13, marginTop: 2 }
  })
}
