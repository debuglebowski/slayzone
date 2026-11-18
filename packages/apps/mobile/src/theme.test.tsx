import type { HubThemeSettings } from '@slayzone/theme-tokens'
import { render } from '@testing-library/react-native'
import { Appearance, Text } from 'react-native'
import { KeptThemeProvider, systemSchemeOverride } from './theme'

const hub = (
  stored: Partial<HubThemeSettings['stored']>,
  preference: string | null = 'system'
): HubThemeSettings => ({
  preference,
  stored: { themeId: null, split: null, themeIdDark: null, themeIdLight: null, ...stored }
})

describe('systemSchemeOverride: the system UI (keyboard, alerts, sheets) follows the painted theme', () => {
  it('an explicit dark or light choice sets the system scheme', () => {
    expect(systemSchemeOverride(hub({ themeId: 'slay' }, 'dark'))).toBe('dark')
    expect(systemSchemeOverride(hub({ themeId: 'slay' }, 'light'))).toBe('light')
  })

  it("a preset without a light variant is always dark, whatever the device's scheme", () => {
    expect(systemSchemeOverride(hub({ themeId: 'nord' }))).toBe('dark')
  })

  it("following the device (system, signed out) leaves the device's own scheme", () => {
    expect(systemSchemeOverride(hub({ themeId: 'slay' }))).toBeNull()
    expect(systemSchemeOverride(null)).toBeNull()
  })
})

describe('KeptThemeProvider', () => {
  it('sets the system scheme to the painted one, and gives it back to the device', async () => {
    const set = jest.spyOn(Appearance, 'setColorScheme')
    const view = await render(
      <KeptThemeProvider settings={hub({ themeId: 'slay' }, 'dark')}>
        <Text>app</Text>
      </KeptThemeProvider>
    )
    expect(set).toHaveBeenLastCalledWith('dark')
    await view.rerender(
      <KeptThemeProvider settings={hub({ themeId: 'slay' })}>
        <Text>app</Text>
      </KeptThemeProvider>
    )
    expect(set).toHaveBeenLastCalledWith('unspecified')
    set.mockRestore()
  })
})
