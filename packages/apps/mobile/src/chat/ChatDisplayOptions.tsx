/**
 * What the chats show of a turn's work, as switches — desktop's Chat display options
 * "Activity" section (`task-terminals/.../ChatDisplayOptions.tsx`), the same settings
 * (`ChatActivitySettings`), kept on this device (`chat-display-prefs.ts`).
 */
import type { ChatActivitySettings } from '@slayzone/terminal/chat-activity'
import { StyleSheet, Switch, Text, View } from 'react-native'
import type { ChromeColors } from '../theme'
import { useChatDisplayPrefs } from './chat-display-prefs-file'
import { useThemedStyles } from './styles'

export function ChatDisplayOptions({ inset = false }: { inset?: boolean }) {
  const { s } = useThemedStyles(makeStyles)
  const [settings, change] = useChatDisplayPrefs()
  const option = (key: keyof ChatActivitySettings, label: string, nested = false) => (
    <View style={[s.row, nested && s.nested]} key={key}>
      <Text style={s.label}>{label}</Text>
      <Switch
        value={settings[key]}
        onValueChange={(value) => change({ [key]: value })}
        accessibilityLabel={label}
        testID={`chat-display-${key}`}
      />
    </View>
  )
  return (
    <View style={inset && s.inset} testID="chat-display-options">
      {option('previewLatestActivity', 'Preview latest activity')}
      {option('showActivities', 'Show activities')}
      {settings.showActivities ? (
        <>
          {option('showActivityMessages', 'Messages', true)}
          {option('showThinking', 'Thinking', true)}
          {option('showActivityTools', 'Tool calls', true)}
        </>
      ) : null}
    </View>
  )
}

function makeStyles(t: ChromeColors) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      minHeight: 44,
      gap: 12
    },
    nested: { paddingLeft: 20 },
    inset: { paddingHorizontal: 10 },
    label: { color: t.foreground, fontSize: 15, flexShrink: 1 }
  })
}
