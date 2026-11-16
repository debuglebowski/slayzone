/**
 * What an UNTRUSTED caller (a remote hub, or an agent on another computer) can make
 * this desktop's browser reach: public addresses only — by name, by DNS resolution
 * (no rebinding: every request is re-checked, and the IP a response actually came
 * from taints the tab), on redirects and on the final page. The user's own browsing
 * is never restricted.
 */
import { describe, expect, test } from 'vitest'
import { PrivateNetworkGuard } from './browser-private-network-guard'

const dns: Record<string, string[]> = {
  'public.test': ['93.184.216.34'],
  'rebind.test': ['10.0.0.7'],
  'dual.test': ['93.184.216.34', '127.0.0.1']
}
const lookup = async (host: string, _wc: number | null): Promise<string[]> => {
  const r = dns[host]
  if (!r) throw new Error('ENOTFOUND')
  return r
}
const guard = () => new PrivateNetworkGuard(lookup)

describe('checkTarget (before an untrusted navigation)', () => {
  test('public names and IPs pass', async () => {
    await expect(guard().checkTarget('https://public.test/x')).resolves.toBeUndefined()
    await expect(guard().checkTarget('http://8.8.8.8/')).resolves.toBeUndefined()
    await expect(guard().checkTarget('about:blank')).resolves.toBeUndefined()
  })
  for (const url of [
    'http://127.0.0.1:51100/health',
    'http://localhost:3000/',
    'http://app.localhost/',
    'http://printer.local/',
    'http://192.168.1.1/admin',
    'http://[::1]:51100/',
    'http://169.254.169.254/latest/meta-data',
    'http://0.0.0.0:51100/',
    'http://rebind.test/',
    'http://dual.test/'
  ]) {
    test(`${url} is refused`, async () => {
      await expect(guard().checkTarget(url)).rejects.toThrow(/private network/)
    })
  }
  test('an unresolvable name is refused (cannot prove it public)', async () => {
    await expect(guard().checkTarget('http://nowhere.test/')).rejects.toThrow(/private network/)
  })
})

describe('requests of a tab an untrusted caller drives', () => {
  test('requests to non-public hosts are blocked; the user’s own tabs are not touched', async () => {
    const g = guard()
    g.markUntrusted(7)
    expect(await g.shouldBlock(7, 'http://127.0.0.1:51100/api/pty')).toBe(true)
    expect(await g.shouldBlock(7, 'http://rebind.test/')).toBe(true)
    expect(await g.shouldBlock(7, 'https://public.test/app.js')).toBe(false)
    expect(await g.shouldBlock(8, 'http://127.0.0.1:51100/api/pty')).toBe(false)
  })
  test('the user navigating the tab ends the restriction', async () => {
    const g = guard()
    g.markUntrusted(7)
    g.clearUntrusted(7)
    expect(await g.shouldBlock(7, 'http://localhost:3000/')).toBe(false)
  })
})

describe('taint: what the tab shows is non-public', () => {
  test('a committed page on a non-public host, by name or by resolution', async () => {
    const g = guard()
    g.committed(9, 'http://localhost:3000/')
    expect(await g.isTainted(9)).toBe(true)
    g.committed(9, 'https://public.test/')
    expect(await g.isTainted(9)).toBe(false)
    g.committed(9, 'http://rebind.test/')
    expect(await g.isTainted(9)).toBe(true)
  })
  test('a page reached through a redirect hop served from a non-public IP', async () => {
    const g = guard()
    g.noteRedirect(7, '127.0.0.1', true)
    g.committed(7, 'https://public.test/landing')
    expect(await g.isTainted(7)).toBe(true)
    g.committed(7, 'https://public.test/next')
    expect(await g.isTainted(7)).toBe(false)
  })
  test('a subresource redirect from a non-public IP taints the current document', async () => {
    const g = guard()
    g.committed(7, 'https://public.test/')
    g.noteRedirect(7, '10.0.0.9', false)
    expect(await g.isTainted(7)).toBe(true)
  })
  test('public redirect hops change nothing; local file pages carry no network taint', async () => {
    const g = guard()
    g.noteRedirect(7, '93.184.216.34', true)
    g.committed(7, 'https://public.test/')
    expect(await g.isTainted(7)).toBe(false)
    g.committed(7, 'slz-file:///Users/u/x.html')
    expect(await g.isTainted(7)).toBe(false)
  })
  test('forget drops all state for a destroyed tab', async () => {
    const g = guard()
    g.markUntrusted(7)
    g.committed(7, 'http://localhost/')
    g.forget(7)
    expect(await g.isTainted(7)).toBe(false)
    expect(g.isUntrusted(7)).toBe(false)
  })
})
