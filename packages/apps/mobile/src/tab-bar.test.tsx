/**
 * Hiding the app's tab bar from a screen (`tab-bar.tsx`): while the screen is focused,
 * held by every screen that asks (the task page and its sheet over it), never outside
 * the signed-in tabs.
 */
import { render, screen, userEvent } from '@testing-library/react-native'
import { type ReactNode, useState } from 'react'
import { Pressable, Text } from 'react-native'
import { TabBarHiding, useHideTabBar, useTabBarHiding } from './tab-bar'

// Focus = mounted here: React Navigation's focus has its own suite.
jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => undefined | (() => void)) => {
    const { useEffect } = jest.requireActual('react')
    useEffect(effect, [effect])
  }
}))

function Tabs({ children }: { children: ReactNode }) {
  const tabBar = useTabBarHiding()
  return (
    <TabBarHiding value={tabBar}>
      <Text testID="bar">{tabBar.hidden ? 'hidden' : 'shown'}</Text>
      {children}
    </TabBarHiding>
  )
}

function Hider({ hide = true }: { hide?: boolean }) {
  useHideTabBar(hide)
  return null
}

function Toggle({ label, children }: { label: string; children: ReactNode }) {
  const [on, setOn] = useState(true)
  return (
    <>
      <Pressable onPress={() => setOn((v) => !v)}>
        <Text>{label}</Text>
      </Pressable>
      {on ? children : null}
    </>
  )
}

const press = (label: string) => userEvent.setup().press(screen.getByText(label))

describe('tab bar hiding', () => {
  it('shown until a screen hides it; shown again once it goes', async () => {
    await render(
      <Tabs>
        <Toggle label="page">
          <Hider />
        </Toggle>
      </Tabs>
    )
    expect(screen.getByTestId('bar')).toHaveTextContent('hidden')
    await press('page')
    expect(screen.getByTestId('bar')).toHaveTextContent('shown')
  })

  it('stays hidden while any screen holds it (the page and its sheet)', async () => {
    await render(
      <Tabs>
        <Toggle label="page">
          <Hider />
        </Toggle>
        <Toggle label="sheet">
          <Hider />
        </Toggle>
      </Tabs>
    )
    await press('sheet')
    expect(screen.getByTestId('bar')).toHaveTextContent('hidden')
    await press('page')
    expect(screen.getByTestId('bar')).toHaveTextContent('shown')
  })

  it('a screen that does not ask leaves it shown', async () => {
    await render(
      <Tabs>
        <Hider hide={false} />
      </Tabs>
    )
    expect(screen.getByTestId('bar')).toHaveTextContent('shown')
  })

  it('outside the tabs, asking does nothing', async () => {
    await render(<Hider />)
  })
})
