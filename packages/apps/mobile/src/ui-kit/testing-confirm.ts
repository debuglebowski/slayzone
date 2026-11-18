/**
 * Test helpers for `confirm.ts`: the system alert does nothing in jest, so a suite
 * stands in for the user's answer.
 */
import { Alert, type AlertButton } from 'react-native'

interface ShownAlert {
  title: string
  message?: string | null
  buttons: AlertButton[]
}

/** The alerts shown, newest last, each with its buttons. */
export function watchAlerts(): {
  alerts: ShownAlert[]
  /** Press the newest alert's button called `text`. */
  press: (text: string) => void
  restore: () => void
} {
  const alerts: ShownAlert[] = []
  const spy = jest.spyOn(Alert, 'alert').mockImplementation((title, message, buttons) => {
    alerts.push({ title: title ?? '', message, buttons: buttons ?? [] })
  })
  return {
    alerts,
    press: (text) => {
      const button = alerts.at(-1)?.buttons.find((b) => b.text === text)
      if (!button) throw new Error(`No alert button "${text}"`)
      button.onPress?.()
    },
    restore: () => spy.mockRestore()
  }
}

/** Every destructive confirmation is accepted at once (a suite about what follows it). */
export function acceptConfirmations(): jest.SpyInstance {
  return jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    buttons?.find((b) => b.style === 'destructive')?.onPress?.()
  })
}
