import { z } from 'zod'
import { isHtmlPrototypeActionId } from '@slayzone/platform/html-prototype-actions'

const manifestId = 'slayzone-prototype'
const controlsMeta = 'slayzone-prototype-controls'
const defaultControlsHeight = 72
const manifestSchema = z.object({
  actions: z.array(
    z.object({ id: z.custom<string>(isHtmlPrototypeActionId), label: z.string().trim().min(1) })
  )
})

export type HtmlPrototype =
  | { kind: 'buttons'; actions: z.infer<typeof manifestSchema>['actions'] }
  | { kind: 'document'; height: number }

export function parseHtmlPrototype(html: string): HtmlPrototype | null {
  if (!html.includes(manifestId)) return null
  // Only read metadata in the renderer. Authored UI runs in a sandboxed frame.
  const template = document.createElement('template')
  template.innerHTML = html
  const controls = template.content.querySelector<HTMLMetaElement>(`meta[name="${controlsMeta}"]`)
  if (controls) {
    const height = Number(controls.content)
    return {
      kind: 'document',
      height: Number.isSafeInteger(height) && height > 0 ? height : defaultControlsHeight
    }
  }
  const json = template.content.querySelector(
    `script#${manifestId}[type="application/json"]`
  )?.textContent
  if (!json) return null

  try {
    const manifest = manifestSchema.safeParse(JSON.parse(json)).data
    if (!manifest?.actions.length) return null
    const { actions } = manifest
    const ids = new Set(actions.map(({ id }) => id))
    return ids.size === actions.length ? { kind: 'buttons', actions } : null
  } catch {
    return null
  }
}
