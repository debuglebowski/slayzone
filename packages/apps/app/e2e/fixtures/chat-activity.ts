import type { Locator } from '@playwright/test'
import { expect } from '@playwright/test'

/** Reveal grouped activity through the same disclosures a user opens. */
export async function expandActivities(
  panel: Locator,
  edge: 'first' | 'last' = 'last'
): Promise<void> {
  const summaries = panel.getByRole('button', { name: /^Activities / })
  const summary = edge === 'first' ? summaries.first() : summaries.last()
  await expect(summary).toBeVisible()
  if ((await summary.getAttribute('aria-expanded')) === 'false') await summary.click()
  await expect(summary).toHaveAttribute('aria-expanded', 'true')
}

export async function openActivityTool(
  panel: Locator,
  testId: string,
  index = 0
): Promise<Locator> {
  await expandActivities(panel)
  const card = panel.getByTestId(testId).nth(index)
  const toggle = card.getByRole('button').first()
  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  return card
}

/** Some cards put their test id inside the disclosed body. Open their named header. */
export async function openActivityCard(panel: Locator, name: RegExp): Promise<Locator> {
  await expandActivities(panel)
  const toggle = panel.getByRole('button', { name }).first()
  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  return toggle.locator('..')
}
