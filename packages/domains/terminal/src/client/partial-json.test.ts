/**
 * parsePartialJson: a tool call's input while it streams (plan 3.2) — the
 * object as far as it arrived, so a card can show the command / file as it grows.
 */
import { expect, test } from 'vitest'
import { parsePartialJson } from './partial-json'

test('complete JSON parses as is', () => {
  expect(parsePartialJson('{"command":"ls -la","description":"List"}')).toEqual({
    command: 'ls -la',
    description: 'List'
  })
})

test('an unterminated string keeps what arrived', () => {
  expect(parsePartialJson('{"command": "npm run bu')).toEqual({ command: 'npm run bu' })
})

test('a dangling key, colon or comma is dropped', () => {
  expect(parsePartialJson('{"command": "ls", "desc')).toEqual({ command: 'ls' })
  expect(parsePartialJson('{"command": "ls", "description":')).toEqual({ command: 'ls' })
  expect(parsePartialJson('{"command": "ls",')).toEqual({ command: 'ls' })
  expect(parsePartialJson('{"command"')).toEqual({})
})

test('nested arrays and objects close in order', () => {
  expect(parsePartialJson('{"edits": [{"old_string": "a", "new_string": "b')).toEqual({
    edits: [{ old_string: 'a', new_string: 'b' }]
  })
  expect(parsePartialJson('{"todos": [1, 2')).toEqual({ todos: [1, 2] })
})

test('escapes stay intact; a cut escape is dropped', () => {
  expect(parsePartialJson('{"content": "line1\\nline2 \\"q\\"')).toEqual({
    content: 'line1\nline2 "q"'
  })
  expect(parsePartialJson('{"content": "a\\')).toEqual({ content: 'a' })
  expect(parsePartialJson('{"content": "a\\u00')).toEqual({ content: 'a' })
})

test('a partial literal or number is dropped, not guessed', () => {
  expect(parsePartialJson('{"a": 1, "b": tr')).toEqual({ a: 1 })
  expect(parsePartialJson('{"a": 1, "b": -')).toEqual({ a: 1 })
})

test('nothing usable → undefined', () => {
  expect(parsePartialJson('')).toBeUndefined()
  expect(parsePartialJson('   ')).toBeUndefined()
})
