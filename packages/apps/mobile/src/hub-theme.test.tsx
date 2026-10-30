import type { HubThemeSettings } from '@slayzone/theme-tokens'
import { act, render, waitFor } from '@testing-library/react-native'
import { HubThemeReader } from './hub-theme'
import { pending, trpcTest } from './testing'

/** A hub answering the theme settings from `values`, with a push for "settings changed". */
function themeHub(values: Record<string, string | null>, preference = 'dark') {
  const push: { settings: (data: unknown) => void } = { settings: () => undefined }
  const test = trpcTest({
    procedures: {
      'settings.getThemeSource': () => preference,
      'settings.get': ({ key }: { key: string }) => values[key] ?? null
    },
    subscriptions: {
      'notify.onSettingsChanged': (_input, emit) => {
        push.settings = emit
      },
      'settings.onThemeChanged': () => undefined
    }
  })
  return { ...test, push }
}

describe('HubThemeReader', () => {
  it("reads the user's theme settings from the hub", async () => {
    const onSettings = jest.fn()
    const { wrapper } = themeHub({ app_theme_id: 'nord' })
    await render(<HubThemeReader onSettings={onSettings} />, { wrapper })

    await waitFor(() =>
      expect(onSettings).toHaveBeenLastCalledWith({
        preference: 'dark',
        stored: {
          themeId: 'nord',
          split: null,
          themeIdDark: null,
          themeIdLight: null,
          legacyThemeId: null
        }
      } satisfies HubThemeSettings)
    )
  })

  it('reports nothing until every setting has loaded (no half-applied theme)', async () => {
    const onSettings = jest.fn()
    const { wrapper } = trpcTest({
      procedures: { 'settings.getThemeSource': () => 'dark', 'settings.get': pending },
      subscriptions: {
        'notify.onSettingsChanged': () => undefined,
        'settings.onThemeChanged': () => undefined
      }
    })
    await render(<HubThemeReader onSettings={onSettings} />, { wrapper })
    await act(async () => undefined)
    expect(onSettings).not.toHaveBeenCalled()
  })

  it('follows a theme another client changes', async () => {
    const onSettings = jest.fn()
    const values: Record<string, string | null> = { app_theme_id: 'nord' }
    const { wrapper, push } = themeHub(values)
    await render(<HubThemeReader onSettings={onSettings} />, { wrapper })
    await waitFor(() => expect(onSettings.mock.lastCall?.[0].stored.themeId).toBe('nord'))

    values.app_theme_id = 'catppuccin-mocha'
    await act(async () => push.settings({ keys: ['app_theme_id'] }))
    await waitFor(() =>
      expect(onSettings.mock.lastCall?.[0].stored.themeId).toBe('catppuccin-mocha')
    )
  })
})
