/**
 * `engaged` (user input in a web view) goes to the ONE window hosting that view, which
 * forwards it to the hub under its client key: each touch counted once, ownership
 * never a race between windows. Every other host event goes to every window.
 */
import { expect, test } from 'vitest'
import { recipientsFor } from './browser-host-routing'

const w = (id: number) => ({ id })
const subs = [w(1), w(2), w(3)]

test('engaged goes only to the window hosting the view', () => {
  expect(recipientsFor('engaged', { taskId: 't', hostWebContentsId: 2 }, subs)).toEqual([w(2)])
})

test('engaged from a view whose window is not subscribed still reaches one window (idle-close)', () => {
  expect(recipientsFor('engaged', { taskId: 't', hostWebContentsId: 9 }, subs)).toEqual([w(1)])
  expect(recipientsFor('engaged', { taskId: 't', hostWebContentsId: null }, subs)).toEqual([w(1)])
})

test('other events are broadcast', () => {
  expect(recipientsFor('event', { viewId: 'v', type: 'dom-ready' }, subs)).toEqual(subs)
  expect(recipientsFor('shortcut', {}, subs)).toEqual(subs)
})

test('no subscribers, no recipients', () => {
  expect(recipientsFor('engaged', { taskId: 't', hostWebContentsId: 1 }, [])).toEqual([])
})
