import { describe, expect, test } from 'vitest'
import { isNonPublicIp, isNonPublicHostname, BROWSER_PANEL_REQUEST_HEADER } from './browser-network'

describe('isNonPublicIp', () => {
  const nonPublic = [
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:192.168.0.1',
    '[::1]'
  ]
  for (const ip of nonPublic)
    test(`${ip} is not public`, () => expect(isNonPublicIp(ip)).toBe(true))
  const pub = [
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '192.169.0.1',
    '2606:4700::1111',
    '::ffff:8.8.8.8'
  ]
  for (const ip of pub) test(`${ip} is public`, () => expect(isNonPublicIp(ip)).toBe(false))
  test('a non-IP is not judged', () => expect(isNonPublicIp('example.com')).toBe(false))
})

describe('isNonPublicHostname', () => {
  for (const h of [
    'localhost',
    'LOCALHOST',
    'app.localhost',
    'printer.local',
    '127.0.0.1',
    '[::1]',
    '10.1.1.1',
    '0.0.0.0',
    'localhost.'
  ]) {
    test(`${h} is not public`, () => expect(isNonPublicHostname(h)).toBe(true))
  }
  for (const h of ['example.com', 'github.com', '8.8.8.8', 'localhost.example.com']) {
    test(`${h} is not judged non-public by name`, () => expect(isNonPublicHostname(h)).toBe(false))
  }
})

test('the panel marker header is lower-case and SlayZone-scoped', () => {
  expect(BROWSER_PANEL_REQUEST_HEADER).toBe('x-slayzone-browser-panel')
})
