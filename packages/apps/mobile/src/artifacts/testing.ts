/**
 * Test-only helpers for the artifact suites (never imported by app code).
 */
import { resolveNativeTheme } from '@slayzone/theme-tokens'
import type { HubFetch } from './hub-rest'
import type { PageTheme } from './pages/page-style'

export interface FakeFetchCall {
  url: string
  init: { method: string; headers: Record<string, string>; credentials?: string }
}

/** A `fetch` answering every request with `answer` (JSON-encoded unless a string), and its log. */
export function fakeFetch(
  answer: (call: FakeFetchCall) => { status: number; body: unknown }
): HubFetch & { calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = []
  const fetch = async (url: string, init: FakeFetchCall['init']) => {
    const call = { url, init }
    calls.push(call)
    const { status, body } = answer(call)
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return { status, ok: status >= 200 && status < 300, text: async () => text }
  }
  return Object.assign(fetch, { calls })
}

/** The default preset's colours in one variant, as the pages get them. */
export function testPageTheme(variant: 'dark' | 'light'): PageTheme {
  return { colors: resolveNativeTheme(null, variant).colors, variant }
}
