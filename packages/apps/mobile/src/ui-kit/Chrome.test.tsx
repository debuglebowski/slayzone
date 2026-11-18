import { render, screen, userEvent, waitFor } from '@testing-library/react-native'
import { StyleSheet, Text } from 'react-native'
import { SCRIM } from '../theme'
import {
  BottomSheet,
  Caption,
  CountBadge,
  IconButton,
  MODAL_ORIENTATIONS,
  Pill,
  SHEET_MAX_WIDTH,
  sheetDismissed
} from './Chrome'

const flat = (style: unknown) => StyleSheet.flatten(style as never) ?? {}

/** The height a press lands on: the view's own plus its hit slop. */
function touchHeight(el: { props: { style?: unknown; hitSlop?: unknown } }, own: number): number {
  const slop = el.props.hitSlop
  if (typeof slop === 'number') return own + 2 * slop
  const s = (slop ?? {}) as { top?: number; bottom?: number }
  return own + (s.top ?? 0) + (s.bottom ?? 0)
}

describe('BottomSheet', () => {
  const sheet = (onClose = jest.fn()) =>
    render(
      <BottomSheet visible onClose={onClose} testID="s">
        <Text>Body</Text>
      </BottomSheet>
    )

  it('rotates with the app: every orientation, not portrait only', async () => {
    await sheet()
    expect(screen.getByTestId('s-modal').props.supportedOrientations).toBe(MODAL_ORIENTATIONS)
    expect(MODAL_ORIENTATIONS).toEqual(
      expect.arrayContaining(['portrait', 'landscape-left', 'landscape-right'])
    )
  })

  it('dims the screen with a dark scrim, never a veil of the background colour', async () => {
    await sheet()
    const dim = flat(screen.getByTestId('s-backdrop').props.style)
    expect(Object.values(SCRIM)).toContain(dim.backgroundColor)
  })

  it('keeps its content above the keyboard', async () => {
    await sheet()
    // KeyboardAvoidingView's view: it measures itself against the keyboard's frame.
    expect(screen.getByTestId('s-keyboard').props.onLayout).toBeInstanceOf(Function)
  })

  it('stays a readable width on an iPad: capped and centred', async () => {
    await sheet()
    const style = flat(screen.getByTestId('s').props.style)
    expect(style.maxWidth).toBe(SHEET_MAX_WIDTH)
    expect(style.alignSelf).toBe('center')
  })

  it('slides up instead of fading the whole sheet in', async () => {
    await sheet()
    const style = flat(screen.getByTestId('s').props.style)
    expect(style.transform).toEqual(expect.arrayContaining([expect.anything()]))
  })

  it('closes on a tap outside', async () => {
    const onClose = jest.fn()
    await sheet(onClose)
    await userEvent.setup().press(screen.getByTestId('s-backdrop'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('has a grab handle that can be dragged down', async () => {
    await sheet()
    expect(screen.getByTestId('s-grab').props.onResponderRelease).toBeInstanceOf(Function)
  })
})

describe('sheetDismissed (dragging the grab handle)', () => {
  it('a long drag or a quick flick down closes', async () => {
    expect(sheetDismissed(120, 0.1)).toBe(true)
    expect(sheetDismissed(20, 1.2)).toBe(true)
  })
  it('a short slow drag, or one up, springs back', async () => {
    expect(sheetDismissed(30, 0.2)).toBe(false)
    expect(sheetDismissed(-80, -1)).toBe(false)
  })
})

describe('touch targets and Dynamic Type', () => {
  it('a pill is at least 44pt tall to a finger', async () => {
    await render(<Pill label="Todo" onPress={() => undefined} testID="p" />)
    const pill = screen.getByTestId('p')
    const own = flat(pill.props.style)
    // padding 5 + 13pt text ≈ 26pt of its own; the slop makes up the rest.
    expect(touchHeight(pill, (own.paddingVertical ?? 0) * 2 + 16)).toBeGreaterThanOrEqual(44)
  })

  it('an icon button is at least 44pt to a finger', async () => {
    await render(<IconButton label="Search" glyph="⌕" onPress={() => undefined} testID="i" />)
    const button = screen.getByTestId('i')
    const own = flat(button.props.style)
    expect(touchHeight(button, own.minHeight ?? own.height)).toBeGreaterThanOrEqual(44)
    // Grows with larger text instead of clipping its glyph.
    expect(own.height).toBeUndefined()
  })

  it('a count badge grows with larger text', async () => {
    await render(<CountBadge count={12} />)
    const badge = flat(screen.getByTestId('count-badge').props.style)
    expect(badge.height).toBeUndefined()
    expect(badge.minHeight).toBe(16)
  })

  it('a caption is a header to VoiceOver', async () => {
    await render(<Caption>Hubs</Caption>)
    expect(screen.getByRole('header', { name: 'Hubs' })).toBeTruthy()
  })
})
