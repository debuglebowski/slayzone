import { describe, expect, test } from 'vitest'
import {
  isNonPublicIp,
  isNonPublicHostname,
  parseIp,
  BROWSER_PANEL_REQUEST_HEADER
} from './browser-network'

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

describe('review 3: every textual form of a non-public address (classified on the numeric value)', () => {
  const nonPublic = [
    // IPv4-mapped IPv6, the HEX form WHATWG URL serialises ([::ffff:127.0.0.1] → [::ffff:7f00:1])
    '::ffff:7f00:1',
    '[::ffff:7f00:1]',
    '::ffff:a00:1',
    '::ffff:c0a8:101',
    '0:0:0:0:0:ffff:7f00:1',
    // IPv4-compatible
    '::7f00:1',
    '::127.0.0.1',
    // NAT64 / local-use NAT64
    '64:ff9b::7f00:1',
    '64:ff9b::127.0.0.1',
    '64:ff9b::a00:1',
    '64:ff9b:1::1',
    // 6to4 (embedded IPv4 in bytes 2-5)
    '2002:7f00:1::1',
    '2002:c0a8:101::1',
    // site-local, Teredo, discard, documentation
    'fec0::1',
    'feff::1',
    '2001::1',
    '100::1',
    '2001:db8::1',
    // zone ids
    'fe80::1%en0',
    // IPv4 in decimal / octal / hex / short forms
    '2130706433',
    '0177.0.0.1',
    '0x7f.1',
    '127.1',
    '0x7f000001',
    '10.1',
    // broadcast, benchmarking, reserved
    '255.255.255.255',
    '198.18.0.1',
    '240.0.0.1',
    '192.0.0.1',
    '192.0.2.1'
  ]
  for (const ip of nonPublic)
    test(`${ip} is not public`, () => expect(isNonPublicIp(ip)).toBe(true))

  const pub = [
    '2002:808:808::1', // 6to4 of 8.8.8.8
    '64:ff9b::808:808', // NAT64 of 8.8.8.8
    '::ffff:808:808',
    '2606:4700:4700::1111',
    '134744072' // 8.8.8.8 in decimal
  ]
  for (const ip of pub) test(`${ip} is public`, () => expect(isNonPublicIp(ip)).toBe(false))

  test('parseIp returns the bytes, or null for a non-IP', () => {
    expect(parseIp('127.0.0.1')).toEqual(new Uint8Array([127, 0, 0, 1]))
    expect(parseIp('0x7f.1')).toEqual(new Uint8Array([127, 0, 0, 1]))
    expect(parseIp('::ffff:7f00:1')?.length).toBe(16)
    for (const bad of ['example.com', '1.2.3.4.5', '::ffff::1', '256.0.0.1', '', ':::', '1::2::3'])
      expect(parseIp(bad)).toBeNull()
  })

  test('hostnames: the URL parser’s own normalised forms are caught', () => {
    for (const raw of [
      'http://[::ffff:127.0.0.1]:51100/',
      'http://0x7f.1:51100/',
      'http://2130706433/',
      'http://[64:ff9b::127.0.0.1]/'
    ]) {
      expect(isNonPublicHostname(new URL(raw).hostname)).toBe(true)
    }
  })
})
