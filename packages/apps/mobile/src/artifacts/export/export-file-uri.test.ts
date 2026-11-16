/**
 * Review 6, #3: a title with `#`, `%` or `?` must not lose part of its file name. The
 * export never writes a URI itself: it names the file (`exportFileName`) and builds it
 * with `new File(dir, name)`, whose join (expo-file-system's `Paths.join`) percent-
 * encodes every segment after the first (`%` → `%25`, `#` → `%23`, `?` → `%3F`, space,
 * `\`, CR/LF/TAB). The native side reads that URI with `URL(string:)` (iOS, expo-modules-
 * core's URL convertible) / `Uri` (Android), which decodes it back to the same name, and
 * expo-sharing takes the URI the same way. These tests run expo-file-system's real JS
 * and the app's real `URL` (expo's whatwg-url-minimum) and parse the URI as an RFC 3986
 * reader does: no fragment, no query, the path decoding to the name.
 */
import { Directory, File } from 'expo-file-system'
import { exportFileName } from './export-formats'

const EXPORT_DIR =
  'file:///var/mobile/Containers/Data/Application/X/Library/Caches/slayzone-exports/k1-1/'

describe("an export's file URI keeps every character of its name", () => {
  it.each([
    ['Issue #12 notes.md', 'Issue #12 notes.pdf'],
    ['100% done.md', '100% done.pdf'],
    // `?` is one of the names Windows refuses: the shared planner (`safeFileName`)
    // replaces it, as on every client.
    ['what? why.md', 'what_ why.pdf'],
    ['50%23 #a?b=c.md', '50%23 #a_b=c.pdf']
  ])('%s → %s', (title, expected) => {
    const name = exportFileName(title, 'pdf')
    expect(name).toBe(expected)
    expectFileNamed(name)
  })

  it('a name with `?` in it, as the URI join would get one', () => {
    expectFileNamed('a?b #c%d%3F.pdf')
  })
})

/** `<export dir>/<expected>` through expo-file-system, read back as the native side does. */
function expectFileNamed(expected: string): void {
  const file = new File(new Directory(EXPORT_DIR), expected)
  expect(file.name).toBe(expected)
  expect(file.extension).toBe('.pdf')

  const url = new URL(file.uri)
  expect(url.hash).toBe('')
  expect(url.search).toBe('')
  expect(decodeURIComponent(url.pathname)).toBe(`${new URL(EXPORT_DIR).pathname}${expected}`)
}
