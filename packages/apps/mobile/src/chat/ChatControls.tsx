/**
 * The chat's permission mode, model and effort as three chips (desktop's chat pills);
 * a tap lists the choices in a sheet. The models are the hub's (`chat.getModels`);
 * effort shows only for a model that has it, with that model's own levels.
 */
import type { ChatModelsView } from '@slayzone/terminal-contracts'
import { useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { ChromeColors } from '../theme'
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

type Picker = 'mode' | 'model' | 'effort'

export function ChatControls({
  mode,
  settings,
  models
}: {
  mode: string
  settings: ChatSettings
  models: ChatModelsView
}) {
  const { s } = useThemedStyles(makeStyles)
  const [picker, setPicker] = useState<Picker | null>(null)
  const showEffort = !!settings.model && models.supportsEffort(settings.model)
  const effortLevels = settings.model ? models.effortLevels(settings.model) : undefined

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
          : null

  return (
    <View style={s.bar}>
      <Chip
        label={settings.mode ? modeLabel(settings.mode) : 'Mode'}
        busy={settings.changing.mode}
        onPress={() => setPicker('mode')}
        a11y="Permission mode"
        s={s}
      />
      <Chip
        label={modelChipLabel(models, settings.model)}
        busy={settings.changing.model}
        onPress={() => setPicker('model')}
        a11y="Model"
        s={s}
      />
      {showEffort && (
        <Chip
          label={effortLabel(settings.effort, effortLevels)}
          busy={settings.changing.effort}
          onPress={() => setPicker('effort')}
          a11y="Effort"
          s={s}
        />
      )}
      <Modal
        visible={sheet !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setPicker(null)}
      >
        <Pressable style={s.backdrop} onPress={() => setPicker(null)} accessibilityLabel="Close" />
        {sheet && (
          <View style={s.sheet}>
            <Text style={s.sheetTitle}>{sheet.title}</Text>
            {sheet.options.length === 0 && sheet.hint ? (
              <Text style={s.sheetHint}>{sheet.hint}</Text>
            ) : null}
            <ScrollView>
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
          </View>
        )}
      </Modal>
    </View>
  )
}

type Styles = ReturnType<typeof makeStyles>

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
    bar: { flexDirection: 'row', gap: 6, paddingHorizontal: 8, paddingTop: 6 },
    chip: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      backgroundColor: t.surface1,
      maxWidth: 170
    },
    chipBusy: { opacity: 0.6 },
    chipText: { color: t.foreground, fontSize: 12, fontWeight: '600' },
    backdrop: { flex: 1 },
    sheet: {
      maxHeight: '60%',
      backgroundColor: t.popover,
      borderTopLeftRadius: 14,
      borderTopRightRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      paddingHorizontal: 12,
      paddingTop: 12,
      paddingBottom: 28
    },
    sheetTitle: { color: t.popoverForeground, fontSize: 15, fontWeight: '700', marginBottom: 8 },
    sheetHint: { color: t.mutedForeground, fontSize: 13, paddingHorizontal: 10, paddingBottom: 8 },
    option: { paddingVertical: 10, paddingHorizontal: 10, borderRadius: 8 },
    optionOn: { backgroundColor: t.accent },
    optionLabel: { color: t.popoverForeground, fontSize: 15, fontWeight: '600' },
    optionDescription: { color: t.mutedForeground, fontSize: 13, marginTop: 2 }
  })
}
