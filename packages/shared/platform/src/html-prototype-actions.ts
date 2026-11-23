export const HTML_PROTOTYPE_ACTION = 'slayzone:prototype-action'
export const HTML_PROTOTYPE_READY = 'slayzone:prototype-ready'

export type HtmlPrototypeActionValue = string | number | boolean | null

export interface HtmlPrototypeActionMessage {
  type: typeof HTML_PROTOTYPE_ACTION
  action: string
  value?: HtmlPrototypeActionValue
}

export function isHtmlPrototypeActionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)
}

export function parseHtmlPrototypeAction(input: unknown): HtmlPrototypeActionMessage | null {
  if (typeof input !== 'object' || input === null) return null
  const { type, action, value } = input as Record<string, unknown>
  if (type !== HTML_PROTOTYPE_ACTION || !isHtmlPrototypeActionId(action)) return null
  if (value === undefined) return { type, action }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return { type, action, value }
  }
  return null
}
