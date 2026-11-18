import { clampScroll, dropTarget, edgeScrollSpeed } from './drag'

// Kanban: two columns side by side; rows stacked in each.
const targets = {
  columns: [
    { id: 'todo', rect: { x: 0, y: 0, width: 100, height: 400 } },
    { id: 'done', rect: { x: 100, y: 0, width: 100, height: 400 } },
    // A phone's column chip: dropping on it = the end of that column.
    { id: 'review', rect: { x: 0, y: 420, width: 60, height: 30 }, atEnd: true }
  ],
  rows: [
    { taskId: 'a', columnId: 'todo', rect: { x: 0, y: 0, width: 100, height: 40 } },
    { taskId: 'b', columnId: 'todo', rect: { x: 0, y: 40, width: 100, height: 40 } },
    { taskId: 'c', columnId: 'done', rect: { x: 100, y: 0, width: 100, height: 40 } },
    // The review column's rows, laid out on its own (off-screen) page below the chip.
    { taskId: 'r', columnId: 'review', rect: { x: 400, y: 500, width: 100, height: 40 } }
  ]
}

describe('dropTarget', () => {
  it('lands before the first row whose middle is below the finger', () => {
    expect(dropTarget(targets, { x: 50, y: 10 })).toEqual({ column: 'todo', beforeTaskId: 'a' })
    expect(dropTarget(targets, { x: 50, y: 30 })).toEqual({ column: 'todo', beforeTaskId: 'b' })
    expect(dropTarget(targets, { x: 50, y: 70 })).toEqual({ column: 'todo', beforeTaskId: null })
    expect(dropTarget(targets, { x: 150, y: 300 })).toEqual({ column: 'done', beforeTaskId: null })
  })

  it("a chip is its column's end, even with the column's rows laid out below it", () => {
    expect(dropTarget(targets, { x: 30, y: 430 })).toEqual({ column: 'review', beforeTaskId: null })
  })

  it('outside every column = nowhere', () => {
    expect(dropTarget(targets, { x: 300, y: 10 })).toBeNull()
  })
})

describe('edgeScrollSpeed', () => {
  // A viewport from 100 to 500 (length 400), edge zones of 50, top speed 10.
  const speed = (pos: number) => edgeScrollSpeed(pos, 100, 400, { zone: 50, max: 10 })

  it('is still away from the edges', () => {
    expect(speed(150)).toBe(0)
    expect(speed(300)).toBe(0)
    expect(speed(450)).toBe(0)
  })

  it('scrolls back near the start and on near the end, faster closer to the edge', () => {
    expect(speed(140)).toBeLessThan(0)
    expect(speed(110)).toBeLessThan(speed(140))
    expect(speed(460)).toBeGreaterThan(0)
    expect(speed(490)).toBeGreaterThan(speed(460))
    expect(speed(100)).toBe(-10)
    expect(speed(499)).toBeCloseTo(10, 0)
  })

  it('never scrolls for a finger outside the viewport (e.g. over the column strip)', () => {
    expect(speed(60)).toBe(0)
    expect(speed(520)).toBe(0)
  })

  it('a viewport too small for two zones splits it in halves', () => {
    const small = (pos: number) => edgeScrollSpeed(pos, 0, 60, { zone: 50, max: 10 })
    expect(small(10)).toBeLessThan(0)
    expect(small(50)).toBeGreaterThan(0)
    expect(small(30)).toBe(0)
  })
})

describe('clampScroll', () => {
  it('keeps the offset within the content', () => {
    expect(clampScroll(100, 20, { content: 1000, viewport: 400 })).toBe(120)
    expect(clampScroll(10, -20, { content: 1000, viewport: 400 })).toBe(0)
    expect(clampScroll(590, 20, { content: 1000, viewport: 400 })).toBe(600)
    // Content shorter than its viewport: nowhere to scroll.
    expect(clampScroll(0, 20, { content: 300, viewport: 400 })).toBe(0)
  })
})
