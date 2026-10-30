import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { type ChromeColors, useTheme } from '../theme'
import type { ProjectRef, ProjectRow } from './hub-projects'
import { ProjectList } from './ProjectList'
import { useHubProjects } from './use-hub-projects'

/**
 * Switch project: every signed-in hub's projects in a sheet, grouped by hub. Hands back
 * the row picked (`hubId` + `project`: a project id alone is ambiguous across hubs) and
 * closes. For screens that show one project at a time (the board).
 */
export function ProjectPicker({
  visible,
  selected,
  onSelect,
  onClose
}: {
  visible: boolean
  selected: ProjectRef | null
  onSelect: (row: ProjectRow) => void
  onClose: () => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const groups = useHubProjects()
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="formSheet"
      onRequestClose={onClose}
    >
      <View testID="project-picker" style={styles.sheet}>
        <View style={styles.header}>
          <Text style={styles.title}>Projects</Text>
          <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button">
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
        </View>
        <ProjectList
          groups={groups}
          selected={selected}
          onSelect={(row) => {
            onClose()
            onSelect(row)
          }}
        />
      </View>
    </Modal>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    sheet: { flex: 1, backgroundColor: t.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    title: { flex: 1, fontSize: 17, fontWeight: '600', color: t.foreground },
    link: { fontSize: 15, color: t.foreground, fontWeight: '500' }
  })
