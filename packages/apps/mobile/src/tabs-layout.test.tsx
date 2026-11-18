/**
 * The signed-in tabs (`app/(tabs)/_layout.tsx`): on iPad the board has its own projects
 * rail, so iOS's tab bar must never turn into a sidebar beside it — `sidebarAdaptable`
 * is `false` explicitly (left unset, expo-router picks the `automatic` mode, which
 * iPadOS may still show as a sidebar).
 */
import { render } from '@testing-library/react-native'
import type { ReactNode } from 'react'

const tabsProps: Record<string, unknown>[] = []
/** Whether a screen inside the tabs asks to hide the tab bar (the phone's task page). */
const mockScreen = { hidesTabBar: false }

jest.mock('expo-router/native-tabs', () => {
  const { useHideTabBar } = jest.requireActual('./tab-bar')
  const Screen = () => {
    useHideTabBar(mockScreen.hidesTabBar)
    return null
  }
  const NativeTabs = (props: Record<string, unknown> & { children?: ReactNode }) => {
    tabsProps.push(props)
    return <Screen />
  }
  const Trigger = () => null
  Trigger.Icon = () => null
  Trigger.Label = () => null
  NativeTabs.Trigger = Trigger
  return { NativeTabs }
})
// Focus = mounted here.
jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => undefined | (() => void)) => {
    const { useEffect } = jest.requireActual('react')
    useEffect(effect, [effect])
  }
}))
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

  it('shows the tab bar until a focused screen hides it (the phone task page)', async () => {
    mockScreen.hidesTabBar = false
    await render(<TabsLayout />)
    expect(tabsProps.at(-1)?.hidden).toBe(false)
    mockScreen.hidesTabBar = true
    await render(<TabsLayout />)
    expect(tabsProps.at(-1)?.hidden).toBe(true)
  })
})
