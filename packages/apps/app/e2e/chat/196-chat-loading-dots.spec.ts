import type { Locator } from '@playwright/test'
import { resetApp } from '../fixtures/electron'
import { ev, expect, step, test } from '../fixtures/chat'

/** Sample the actual CSS animation at a fixed point, without wall-clock sleeps. */
async function pose(loader: Locator, milliseconds: number) {
  return loader.evaluate(async (element, time) => {
    for (const animation of element.getAnimations({ subtree: true })) {
      animation.pause()
      animation.currentTime = time
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const bounds = element.getBoundingClientRect()
    return [...element.querySelectorAll('.loading-dots-dot')].map((dot) => {
      const seed = dot.querySelector('.loading-dots-seed')!
      const rect = seed.getBoundingClientRect()
      return {
        z: new DOMMatrixReadOnly(getComputedStyle(dot).transform).m43,
        width: rect.width,
        inside:
          rect.left >= bounds.left &&
          rect.right <= bounds.right &&
          rect.top >= bounds.top &&
          rect.bottom <= bounds.bottom
      }
    })
  }, milliseconds)
}

test.describe('Chat working dots', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('three matte dots orbit through depth, stay compact, and respect reduced motion', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Chat loading dots',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(ev.init()),
                step.sleep(8_000),
                step.emit(ev.text('Done waiting.'), ev.result({ text: 'Done waiting.' }))
              ]
            ]
          }
        ]
      }
    })
    await t.page.emulateMedia({ reducedMotion: 'no-preference' })
    try {
      await t.send('work silently first')
      const working = t.panel.getByTestId('chat-working-indicator')
      const loader = working.locator('.loading-dots')
      await expect(loader).toBeVisible()
      await expect(loader).toHaveAttribute('aria-hidden', 'true')

      const flat = await pose(loader, 400)
      expect(flat).toHaveLength(3)
      for (const dot of flat) {
        expect(dot.z).toBe(0)
        expect(dot.width).toBeCloseTo(5, 1)
      }

      const orbit = await pose(loader, 2_080)
      expect(orbit.some((dot) => dot.z > 5)).toBe(true)
      expect(orbit.some((dot) => dot.z < -5)).toBe(true)
      expect(Math.max(...orbit.map((dot) => dot.width))).toBeGreaterThan(5)
      expect(Math.min(...orbit.map((dot) => dot.width))).toBeLessThan(5)
      expect(orbit.every((dot) => dot.inside)).toBe(true)

      await t.page.emulateMedia({ reducedMotion: 'reduce' })
      const still = await pose(loader, 2_080)
      for (const dot of still) {
        expect(dot.z).toBe(0)
        expect(dot.width).toBeCloseTo(5, 1)
      }
      expect(
        await loader.evaluate((element) => element.getAnimations({ subtree: true }).length)
      ).toBe(0)

      await expect(t.panel.getByText('Done waiting.', { exact: true }).first()).toBeVisible({
        timeout: 12_000
      })
      await expect(working).toHaveCount(0)
    } finally {
      await t.page.emulateMedia({ reducedMotion: 'no-preference' })
    }
  })
})
