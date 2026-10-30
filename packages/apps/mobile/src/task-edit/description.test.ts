import {
  artifactIdOf,
  artifactLink,
  descriptionUpdate,
  editableDescription,
  hubChanged,
  insertAt
} from './description'

/** What desktop writes: artifact links, task lists, code, a table, odd spacing. */
const DESKTOP = [
  '# Plan',
  '',
  'See [spec.md](artifact:3f2a-11) and [the PR](https://example.com/pr/1).',
  '',
  '- [x] done item',
  '- [ ] open item  ',
  '  - [ ] nested',
  '',
  '```ts',
  'const x = 1   // trailing spaces kept',
  '\tindented()',
  '```',
  '',
  '| a | b |',
  '| --- | :-: |',
  '| 1 | `|` |',
  '',
  '> quote',
  '',
  '',
  '1. one',
  '2. two',
  ''
].join('\n')

const md = (description: string | null) => ({
  description,
  description_format: 'markdown' as const
})

describe('editableDescription', () => {
  it("gives desktop's markdown byte for byte", () => {
    expect(editableDescription(md(DESKTOP))).toBe(DESKTOP)
  })

  it('a task without one has an empty description', () => {
    expect(editableDescription(md(null))).toBe('')
  })

  it("converts a legacy HTML description the way desktop's editor does (normalizeDescription)", () => {
    const html = '<p>Hello <strong>world</strong></p><ul><li><p>a</p></li></ul>'
    expect(editableDescription({ description: html, description_format: 'html' })).toBe(
      'Hello **world**\n\n- a'
    )
  })
})

describe('descriptionUpdate', () => {
  it('nothing changed: nothing to save (desktop’s text, legacy HTML included, stays untouched)', () => {
    expect(descriptionUpdate(DESKTOP, DESKTOP)).toBeNull()
  })

  it('saves the whole edited text exactly as typed', () => {
    const edited = `${DESKTOP}\nmore  \n`
    expect(descriptionUpdate(DESKTOP, edited)).toEqual({ description: edited })
  })

  it('cleared: clears it on the hub', () => {
    expect(descriptionUpdate(DESKTOP, '')).toEqual({ description: null })
  })
})

describe('hubChanged', () => {
  it('compares what the hub holds with what editing started from', () => {
    expect(hubChanged(md(DESKTOP), md(DESKTOP))).toBe(false)
    expect(hubChanged(md(DESKTOP), md(`${DESKTOP}x`))).toBe(true)
    expect(hubChanged(md(null), md(null))).toBe(false)
    expect(hubChanged(md(null), md('new'))).toBe(true)
    expect(hubChanged({ description: '<p>a</p>', description_format: 'html' }, md('a'))).toBe(true)
  })
})

describe('artifact links', () => {
  it('links an artifact the way desktop does: [title](artifact:<id>)', () => {
    expect(artifactLink('a1', 'photo.jpg')).toBe('[photo.jpg](artifact:a1)')
  })

  it('escapes brackets and backslashes in the title', () => {
    expect(artifactLink('a1', 'x [1]\\y.png')).toBe('[x \\[1\\]\\\\y.png](artifact:a1)')
  })

  it('reads the artifact id of a link', () => {
    expect(artifactIdOf('artifact:3f2a-11')).toBe('3f2a-11')
    expect(artifactIdOf('https://example.com')).toBeNull()
    expect(artifactIdOf('artifact:')).toBeNull()
  })
})

describe('insertAt', () => {
  it('inserts at the cursor and leaves every other byte alone', () => {
    const at = DESKTOP.indexOf('- [ ] open')
    const { text, cursor } = insertAt(DESKTOP, { start: at, end: at }, '[a](artifact:1)')
    expect(text).toBe(`${DESKTOP.slice(0, at)}[a](artifact:1)${DESKTOP.slice(at)}`)
    expect(cursor).toBe(at + '[a](artifact:1)'.length)
  })

  it('replaces a selection', () => {
    expect(insertAt('hello world', { start: 6, end: 11 }, 'there')).toEqual({
      text: 'hello there',
      cursor: 11
    })
  })

  it('no cursor yet: appends on a line of its own', () => {
    expect(insertAt('notes', null, '[a](artifact:1)')).toEqual({
      text: 'notes\n[a](artifact:1)',
      cursor: 21
    })
    expect(insertAt('', null, 'x')).toEqual({ text: 'x', cursor: 1 })
    expect(insertAt('notes\n', null, 'x')).toEqual({ text: 'notes\nx', cursor: 7 })
  })

  it('a selection past the end (text changed under it) is clamped', () => {
    expect(insertAt('ab', { start: 5, end: 9 }, 'x')).toEqual({ text: 'abx', cursor: 3 })
  })
})
