/**
 * Tests for parse-diff.ts
 * Run with: npx tsx packages/domains/worktrees/src/client/parse-diff.test.ts
 */
import { parseUnifiedDiff, computeInlineHighlights, ensureInlineHighlights } from './parse-diff'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`✗ ${name}`)
    console.error(`  ${e}`)
    failed++
  }
}

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    toEqual(expected: unknown) {
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    toHaveLength(n: number) {
      if (!Array.isArray(actual) || actual.length !== n)
        throw new Error(`Expected length ${n}, got ${Array.isArray(actual) ? actual.length : 'non-array'}`)
    }
  }
}

// ── parseUnifiedDiff ─────────────────────────────────────────────────

test('empty string returns empty array', () => {
  expect(parseUnifiedDiff('')).toEqual([])
  expect(parseUnifiedDiff('  \n  ')).toEqual([])
})

test('single file single hunk', () => {
  const patch = `diff --git a/file.txt b/file.txt
index abc..def 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 line1
-old line
+new line
 line3`
  const files = parseUnifiedDiff(patch)
  expect(files).toHaveLength(1)
  expect(files[0].path).toBe('file.txt')
  expect(files[0].oldPath).toBe(null)
  expect(files[0].isNew).toBe(false)
  expect(files[0].isDeleted).toBe(false)
  expect(files[0].isBinary).toBe(false)
  expect(files[0].additions).toBe(1)
  expect(files[0].deletions).toBe(1)
  expect(files[0].hunks).toHaveLength(1)
  expect(files[0].hunks[0].oldStart).toBe(1)
  expect(files[0].hunks[0].newStart).toBe(1)
  expect(files[0].hunks[0].lines).toHaveLength(4)
})

test('line numbers track correctly', () => {
  const patch = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -5,4 +5,5 @@
 ctx
-del1
-del2
+add1
+add2
+add3
 ctx`
  const lines = parseUnifiedDiff(patch)[0].hunks[0].lines
  // context at old=5, new=5
  expect(lines[0].oldLineNo).toBe(5)
  expect(lines[0].newLineNo).toBe(5)
  // del1 at old=6
  expect(lines[1].oldLineNo).toBe(6)
  expect(lines[1].newLineNo).toBe(null)
  // del2 at old=7
  expect(lines[2].oldLineNo).toBe(7)
  // add1 at new=6
  expect(lines[3].newLineNo).toBe(6)
  expect(lines[3].oldLineNo).toBe(null)
  // add3 at new=8
  expect(lines[5].newLineNo).toBe(8)
  // trailing context: old=8, new=9
  expect(lines[6].oldLineNo).toBe(8)
  expect(lines[6].newLineNo).toBe(9)
})

test('multiple files parsed', () => {
  const patch = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
+new
diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-foo
+bar`
  const files = parseUnifiedDiff(patch)
  expect(files).toHaveLength(2)
  expect(files[0].path).toBe('a.txt')
  expect(files[1].path).toBe('b.txt')
})

test('new file mode', () => {
  const patch = `diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+line1
+line2`
  const f = parseUnifiedDiff(patch)[0]
  expect(f.isNew).toBe(true)
  expect(f.isDeleted).toBe(false)
  expect(f.additions).toBe(2)
  expect(f.deletions).toBe(0)
})

test('deleted file mode', () => {
  const patch = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-line1
-line2`
  const f = parseUnifiedDiff(patch)[0]
  expect(f.isDeleted).toBe(true)
  expect(f.isNew).toBe(false)
  expect(f.deletions).toBe(2)
  expect(f.additions).toBe(0)
})

test('binary file', () => {
  const patch = `diff --git a/img.png b/img.png
new file mode 100644
Binary files /dev/null and b/img.png differ`
  const f = parseUnifiedDiff(patch)[0]
  expect(f.isBinary).toBe(true)
  expect(f.hunks).toHaveLength(0)
})

test('rename detection (old path != new path)', () => {
  const patch = `diff --git a/old-name.txt b/new-name.txt
similarity index 90%
rename from old-name.txt
rename to new-name.txt
--- a/old-name.txt
+++ b/new-name.txt
@@ -1 +1 @@
-old
+new`
  const f = parseUnifiedDiff(patch)[0]
  expect(f.path).toBe('new-name.txt')
  expect(f.oldPath).toBe('old-name.txt')
})

test('same path means oldPath is null', () => {
  const patch = `diff --git a/same.txt b/same.txt
--- a/same.txt
+++ b/same.txt
@@ -1 +1 @@
-a
+b`
  expect(parseUnifiedDiff(patch)[0].oldPath).toBe(null)
})

test('multiple hunks in one file', () => {
  const patch = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,2 @@
-old1
+new1
 ctx
@@ -10,2 +10,2 @@
-old2
+new2
 ctx`
  const hunks = parseUnifiedDiff(patch)[0].hunks
  expect(hunks).toHaveLength(2)
  expect(hunks[0].oldStart).toBe(1)
  expect(hunks[1].oldStart).toBe(10)
})

test('no newline at end of file marker skipped', () => {
  const patch = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file`
  const lines = parseUnifiedDiff(patch)[0].hunks[0].lines
  // Should only have the delete and add, not the backslash lines
  expect(lines).toHaveLength(2)
  expect(lines[0].type).toBe('delete')
  expect(lines[1].type).toBe('add')
})

test('non-diff-git lines at start are ignored', () => {
  const patch = `some random preamble
not a diff
diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -1 +1 @@
-a
+b`
  const files = parseUnifiedDiff(patch)
  expect(files).toHaveLength(1)
  expect(files[0].path).toBe('f.txt')
})

test('addition and deletion counts across hunks', () => {
  const patch = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,3 @@
-del1
+add1
+add2
 ctx
@@ -10,2 +11,1 @@
-del2
-del3
+add3`
  const f = parseUnifiedDiff(patch)[0]
  expect(f.additions).toBe(3)
  expect(f.deletions).toBe(3)
})

// ── computeInlineHighlights ──────────────────────────────────────────

test('empty strings return empty highlights', () => {
  const r = computeInlineHighlights('', '')
  expect(r.oldHighlights).toEqual([])
  expect(r.newHighlights).toEqual([])
})

test('identical strings return empty', () => {
  const r = computeInlineHighlights('hello world', 'hello world')
  expect(r.oldHighlights).toEqual([])
  expect(r.newHighlights).toEqual([])
})

test('common prefix, different suffix', () => {
  // "hello world" vs "hello earth" — prefix "hello " (6), no common suffix
  // Actually: "hello world" (11) vs "hello earth" (11), prefix "hello ", suffix ""
  // Wait — let me trace:
  //   prefix: h,e,l,l,o,' ' → prefixLen=6
  //   suffix: comparing d vs h, no match → suffixLen=0
  //   common=6, maxLen=11, 6/11=0.54 > 0.3 → highlight
  //   old highlight: [6, 11), new highlight: [6, 11)
  const r = computeInlineHighlights('hello world', 'hello earth')
  expect(r.oldHighlights).toEqual([{ start: 6, end: 11 }])
  expect(r.newHighlights).toEqual([{ start: 6, end: 11 }])
})

test('common suffix, different prefix', () => {
  // "old_value" vs "new_value"
  // prefix: none (o vs n) → prefixLen=0
  // suffix: e,u,l,a,v,_ → suffixLen=6
  // common=6, maxLen=9, 6/9=0.67 > 0.3 → highlight
  // old: [0, 3), new: [0, 3)
  const r = computeInlineHighlights('old_value', 'new_value')
  expect(r.oldHighlights).toEqual([{ start: 0, end: 3 }])
  expect(r.newHighlights).toEqual([{ start: 0, end: 3 }])
})

test('difference in the middle', () => {
  // "abcXXXdef" vs "abcYdef"
  // prefix: a,b,c → 3
  // suffix: d,e,f → 3
  // common=6, maxLen=9, 6/9=0.67 → highlight
  // old: [3, 6), new: [3, 4)
  const r = computeInlineHighlights('abcXXXdef', 'abcYdef')
  expect(r.oldHighlights).toEqual([{ start: 3, end: 6 }])
  expect(r.newHighlights).toEqual([{ start: 3, end: 4 }])
})

test('lines too different returns empty', () => {
  // Completely different strings — 0% common
  const r = computeInlineHighlights('abcdef', 'xyz123')
  expect(r.oldHighlights).toEqual([])
  expect(r.newHighlights).toEqual([])
})

test('just barely above 30% threshold highlights', () => {
  // "aaabbb" (6) vs "aaaccc" (6) — prefix aaa (3), suffix 0
  // common=3, maxLen=6, 3/6=0.5 > 0.3 → should highlight
  const r = computeInlineHighlights('aaabbb', 'aaaccc')
  expect(r.oldHighlights).toEqual([{ start: 3, end: 6 }])
  expect(r.newHighlights).toEqual([{ start: 3, end: 6 }])
})

test('one string longer (insertion)', () => {
  // "abc" vs "abcXYZ" — prefix abc (3), suffix 0
  // common=3, maxLen=6, 3/6=0.5 > 0.3 → highlight
  // old: [3,3) → empty (nothing changed in old), new: [3,6)
  const r = computeInlineHighlights('abc', 'abcXYZ')
  expect(r.oldHighlights).toEqual([])
  expect(r.newHighlights).toEqual([{ start: 3, end: 6 }])
})

test('one string shorter (deletion)', () => {
  // "abcXYZ" vs "abc" — prefix abc (3), suffix 0
  // old: [3,6), new: [3,3) → empty
  const r = computeInlineHighlights('abcXYZ', 'abc')
  expect(r.oldHighlights).toEqual([{ start: 3, end: 6 }])
  expect(r.newHighlights).toEqual([])
})

// ── Inline highlights applied in parseUnifiedDiff ────────────────────

test('inline highlights applied to paired add/delete lines', () => {
  const patch = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,2 @@
-const x = 10;
+const x = 20;
 // end`
  const fd = parseUnifiedDiff(patch)[0]
  // Highlights now computed lazily — caller opts in via ensureInlineHighlights.
  ensureInlineHighlights(fd)
  const lines = fd.hunks[0].lines
  const del = lines[0]
  const add = lines[1]
  // "const x = 10;" vs "const x = 20;"
  // prefix "const x = " (10), suffix "0;" (2) → only "1" vs "2" differs
  expect(del.highlights).toEqual([{ start: 10, end: 11 }])
  expect(add.highlights).toEqual([{ start: 10, end: 11 }])
})

test('ensureInlineHighlights is idempotent', () => {
  const patch = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,2 @@
-const x = 10;
+const x = 20;
 // end`
  const fd = parseUnifiedDiff(patch)[0]
  ensureInlineHighlights(fd)
  ensureInlineHighlights(fd) // second call is a no-op
  const lines = fd.hunks[0].lines
  expect(lines[0].highlights).toEqual([{ start: 10, end: 11 }])
})

test('no highlights when add/delete lines are too different', () => {
  const patch = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -1 +1 @@
-completely different line here
+nothing in common at all xyz`
  const fd = parseUnifiedDiff(patch)[0]
  ensureInlineHighlights(fd)
  const lines = fd.hunks[0].lines
  // These lines share very little — should fall below 30% threshold
  expect(lines[0].highlights).toBe(undefined)
  expect(lines[1].highlights).toBe(undefined)
})

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
