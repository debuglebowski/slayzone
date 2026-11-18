import { keyboardOverlap } from './keyboard-inset'

describe('keyboardOverlap', () => {
  // A sheet from y=60 to y=844 (iPhone form sheet), keyboard top at 508.
  it('is how far the keyboard reaches into the view', () => {
    expect(keyboardOverlap({ y: 60, height: 784 }, 508)).toBe(336)
  })

  it('is 0 with the keyboard below the view, or gone', () => {
    expect(keyboardOverlap({ y: 60, height: 400 }, 508)).toBe(0)
    expect(keyboardOverlap({ y: 60, height: 784 }, null)).toBe(0)
  })
})
