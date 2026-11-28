/**
 * Push notifications to phones (`plans/mobile-push-notifications.md`), the parts a
 * client shares with the hub: what a notification is about and what it carries.
 *
 * @module push
 */

/** What a phone can be told about. Each is a toggle on the phone (`push.setPrefs`). */
export type PushKind = 'ready' | 'error'

/** A phone's choices for one hub. */
export interface PushPrefs {
  ready: boolean
  errors: boolean
}

/**
 * The `data` of every attention notification. `hubRef` is the phone's own name for
 * the hub, given at registration and echoed back, so a tap opens the task on the
 * right hub (`slayzone://task/<hubRef>/<taskId>`).
 */
export interface AttentionPushData {
  kind: 'attention'
  state: PushKind
  taskId: string
  projectId: string
  hubRef: string
}

/** An Expo push token, as `expo-notifications` hands it out. */
export const EXPO_PUSH_TOKEN = /^Expo(nent)?PushToken\[[^\]\s]+\]$/
