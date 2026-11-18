/**
 * A tab's stack (`TabStack`): the tabs that hold a task's page present its Details /
 * Artifacts screen as iOS's sheet — medium first, then large, with a grabber — so the
 * page stays mounted and visible under it.
 */
import { render } from '@testing-library/react-native'
import type { ReactNode } from 'react'

const mockStacks: Array<{ screens: Array<{ name: string; options: Record<string, unknown> }> }> = []

jest.mock('expo-router', () => {
  const Screen = () => null
  const Stack = ({ children }: { children?: ReactNode }) => {
    const { Children: C, isValidElement: valid } = jest.requireActual('react')
    const screens: Array<{ name: string; options: Record<string, unknown> }> = []
    C.forEach(children, (child: unknown) => {
      if (valid(child)) screens.push((child as { props: never }).props)
    })
    mockStacks.push({ screens })
    return null
  }
  Stack.Screen = Screen
  return { Stack }
})
jest.mock('./demo/DemoBanner', () => ({ DemoBanner: () => null }))

import { TabStack } from './TabStack'

beforeEach(() => {
  mockStacks.length = 0
})

describe('TabStack', () => {
  it.each(['board', 'search'] as const)(
    "the %s tab presents a task's Details / Artifacts as a sheet: medium, then large",
    async (tab) => {
      await render(<TabStack tab={tab} />)
      const info = mockStacks.at(-1)?.screens.find((s) => s.name === 'task/[hub]/[id]/info')
      expect(info?.options).toMatchObject({
        presentation: 'formSheet',
        sheetAllowedDetents: [0.5, 1],
        sheetInitialDetentIndex: 0,
        sheetGrabberVisible: true
      })
    }
  )

  it('Settings has no task screens to declare', async () => {
    await render(<TabStack tab="settings" />)
    expect(mockStacks.at(-1)?.screens).toEqual([])
  })
})
