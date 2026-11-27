import type { AppearanceSettings } from '@slayzone/ui'
import type { ChatActivitySettings } from '@slayzone/terminal/chat-activity'

export type ActivityAppearance = Pick<
  AppearanceSettings,
  | 'chatShowActivities'
  | 'chatPreviewLatestActivity'
  | 'chatShowActivityMessages'
  | 'chatShowThinking'
  | 'chatShowActivityTools'
>

/** Desktop's appearance settings as the shared activity display settings. */
export function activitySettingsOf(appearance: ActivityAppearance): ChatActivitySettings {
  return {
    showActivities: appearance.chatShowActivities,
    previewLatestActivity: appearance.chatPreviewLatestActivity,
    showActivityMessages: appearance.chatShowActivityMessages,
    showThinking: appearance.chatShowThinking,
    showActivityTools: appearance.chatShowActivityTools
  }
}
