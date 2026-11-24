import { settingRule } from './registry'

/**
 * Preferences that belong to one device, not to the account
 * (plans/settings-by-scope.md, phase 4): what depends on the machine's screen, fonts,
 * GPU and keyboard. Declared in the registry (`kind: 'device'`); each device keeps its
 * own value (`deviceSettingsLink` in `@slayzone/transport/client`).
 */
export function isDeviceSetting(key: string): boolean {
  return settingRule(key)?.kind === 'device'
}
