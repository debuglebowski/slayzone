/**
 * The signed-in tabs (`app/(tabs)/_layout.tsx`): on iPad the board has its own projects
 * rail, so iOS's tab bar must never turn into a sidebar beside it — `sidebarAdaptable`
 * is `false` explicitly (left unset, expo-router picks the `automatic` mode, which
 * iPadOS may still show as a sidebar).
 */
import { render } from '@testing-library/react-native'
import type { ReactNode } from 'react'

const tabsProps: Record<string, unknown>[] = []

jest.mock('expo-router/native-tabs', () => {
  const NativeTabs = (props: Record<string, unknown> & { children?: ReactNode }) => {
    tabsProps.push(props)
    return null
  }
  const Trigger = () => null
  Trigger.Icon = () => null
  Trigger.Label = () => null
  NativeTabs.Trigger = Trigger
  return { NativeTabs }
})
jest.mock('./dev-launch', () => ({ useDevLaunchLink: () => undefined }))
jest.mock('./home/OpenTasksProvider', () => ({
  OpenTasksProvider: ({ children }: { children: ReactNode }) => children
}))

import TabsLayout from './app/(tabs)/_layout'

describe('signed-in tabs', () => {
  it('never turns the tab bar into a sidebar (iPad has the projects rail)', async () => {
    await render(<TabsLayout />)
    expect(tabsProps.length).toBeGreaterThan(0)
    expect(tabsProps.at(-1)?.sidebarAdaptable).toBe(false)
    expect(tabsProps.at(-1)?.preferredPlacement).toBeUndefined()
  })
})
