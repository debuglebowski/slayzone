/**
 * The chat's permission mode, model and effort as three chips (desktop's chat pills);
 * a tap lists the choices in a sheet. The models are the hub's (`chat.getModels`);
 * effort shows only for a model that has it, with that model's own levels. The chips
 * scroll sideways when they don't fit; the choices open in the app's bottom sheet.
 *
 * `tiles` (the phone task page's agent card): every control as a tile — its name over
 * its value — a tap folding its choices out under the tiles, in the card (the card is
 * a pop-up of its own: a sheet could not open over it); a second tap folds them away.
 */
import type { ChatModelsView } from '@slayzone/terminal-contracts'
import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
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
import { ChatDisplayOptions } from './ChatDisplayOptions'
import { useThemedStyles } from './styles'
import type { ChatSettings } from './useChatSettings'

type Picker = 'mode' | 'model' | 'effort' | 'collaboration'
/** What can open: a setting's choices, or the display options. */
type Open = Picker | 'display'

export function ChatControls({
  mode,
  settings,
  models,
  variant = 'chips'
}: {
  mode: string
  settings: ChatSettings
  models: ChatModelsView
  /**
   * `chips`: the row of chips; `tiles`: every control as a tile (the agent card).
   */
  variant?: 'chips' | 'tiles'
}) {
  const { s } = useThemedStyles(makeStyles)
  const [picker, setPicker] = useState<Open | null>(null)
  const showEffort = !!settings.model && models.supportsEffort(settings.model)
  const effortLevels = settings.model ? models.effortLevels(settings.model) : undefined

  const modeText = settings.mode ? modeLabel(settings.mode) : 'Mode'
  const modelText = modelChipLabel(models, settings.model)
  const effortText = effortLabel(settings.effort, effortLevels)
  const collaborationText = settings.collaboration === 'plan' ? 'Plan' : 'Default'
  /** Every control, in the chips' order (the model first): the tiles. */
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
      {picker === 'display' && (
        <>
          <Text style={s.sheetTitle}>Display</Text>
          <ChatDisplayOptions />
        </>
      )}
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

  if (variant === 'tiles') {
    return (
      <View style={s.tilesWrap}>
        <View style={s.tiles} testID="chat-control-tiles">
          {controls.map((o) => {
            const open = picker === o.picker
            return (
              <Pressable
                key={o.picker}
                onPress={() => setPicker(open ? null : o.picker)}
                style={({ pressed }) => [
                  s.tile,
                  open && s.tileOpen,
                  (o.busy || pressed) && s.chipBusy
                ]}
                accessibilityRole="button"
                accessibilityLabel={o.label}
                accessibilityValue={{ text: o.value }}
                accessibilityState={{ expanded: open }}
                testID={`chat-control-${o.picker}`}
              >
                <Text style={s.tileLabel} numberOfLines={1}>
                  {TILE_LABELS[o.picker]}
                </Text>
                <Text style={s.tileValue} numberOfLines={2}>
                  {o.value}
                  {o.busy ? '…' : ''}
                </Text>
              </Pressable>
            )
          })}
          <Pressable
            onPress={() => setPicker(picker === 'display' ? null : 'display')}
            style={({ pressed }) => [
              s.tile,
              picker === 'display' && s.tileOpen,
              pressed && s.chipBusy
            ]}
            accessibilityRole="button"
            accessibilityLabel="Display"
            accessibilityState={{ expanded: picker === 'display' }}
            testID="chat-control-display"
          >
            <Text style={s.tileLabel} numberOfLines={1}>
              Display
            </Text>
            <Text style={s.tileValue} numberOfLines={2}>
              Activities
            </Text>
          </Pressable>
        </View>
        {picker === 'display' ? (
          <View style={s.inlineChoices} testID="chat-control-choices">
            <ChatDisplayOptions inset />
          </View>
        ) : null}
        {sheet ? (
          <View style={s.inlineChoices} testID="chat-control-choices">
            {sheet.options.length === 0 && sheet.hint ? (
              <Text style={s.sheetHint}>{sheet.hint}</Text>
            ) : null}
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
          </View>
        ) : null}
      </View>
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
      <Chip
        label="Display"
        busy={false}
        onPress={() => setPicker('display')}
        a11y="Display"
        s={s}
      />
      {choices}
    </ScrollView>
  )
}

type Styles = ReturnType<typeof makeStyles>

/** A tile's name: short, as a tile is a third of the card wide. */
const TILE_LABELS: Readonly<Record<Picker, string>> = {
  model: 'Model',
  mode: 'Mode',
  effort: 'Effort',
  collaboration: 'Collaboration'
}

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
    tilesWrap: { gap: 6 },
    tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    tileOpen: { backgroundColor: t.accent },
    inlineChoices: { borderRadius: 14, backgroundColor: t.surface2, padding: 4 },
    tile: {
      flexGrow: 1,
      flexBasis: 90,
      minHeight: 48,
      justifyContent: 'center',
      paddingHorizontal: 10,
      paddingVertical: 7,
      borderRadius: 14,
      backgroundColor: t.surface2
    },
    tileLabel: { color: t.mutedForeground, fontSize: 11, fontWeight: '500' },
    tileValue: { color: t.foreground, fontSize: 13, fontWeight: '600' },
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
