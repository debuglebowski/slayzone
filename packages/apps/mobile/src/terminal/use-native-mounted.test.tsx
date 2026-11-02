import { render } from '@testing-library/react-native'
import { act } from 'react'
import { useNativeMounted } from './use-native-mounted'

describe('useNativeMounted', () => {
  it('is false in the first commit, then true in a later (transition) render', async () => {
    const seen: boolean[] = []
    function Probe() {
      seen.push(useNativeMounted())
      return null
    }
    await render(<Probe />)
    await act(async () => undefined)
    expect(seen[0]).toBe(false)
    expect(seen.at(-1)).toBe(true)
  })
})
