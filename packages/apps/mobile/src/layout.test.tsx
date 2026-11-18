import { renderHook } from '@testing-library/react-native'
import { Dimensions, Platform } from 'react-native'
import { useWide, WIDE_MIN_WIDTH } from './layout'

function windowOf(width: number, height: number) {
  const window = { width, height, scale: 3, fontScale: 1 }
  Dimensions.set({ window, screen: window })
}
const idiom = (pad: boolean) =>
  jest.spyOn(Platform as { readonly isPad: boolean }, 'isPad', 'get').mockReturnValue(pad)

const wide = async () => (await renderHook(() => useWide())).result.current

afterEach(() => jest.restoreAllMocks())

describe('useWide', () => {
  it('is never wide on an iPhone, landscape included', async () => {
    idiom(false)
    windowOf(932, 430) // iPhone Pro Max landscape
    expect(await wide()).toBe(false)
  })

  it('is wide on an iPad at full width and in a half-or-more Split View', async () => {
    idiom(true)
    windowOf(1024, 1366)
    expect(await wide()).toBe(true)
    windowOf(WIDE_MIN_WIDTH, 1366)
    expect(await wide()).toBe(true)
  })

  it('is narrow on an iPad in a narrow Split View or Slide Over', async () => {
    idiom(true)
    windowOf(375, 1366)
    expect(await wide()).toBe(false)
  })
})
