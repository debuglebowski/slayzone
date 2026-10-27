// Reads one vitest JSON report (`--reporter=json --outputFile.json=<path>`) against the
// file list run-all.sh registered for that run. Used by runners.sh after every vitest
// invocation that takes an explicit file list.
//
// vitest silently drops an explicit path its config's include glob doesn't match (and
// a file that dies before collection may be missing too), so the report must hold
// exactly one result per registered file: anything registered-but-unreported or
// reported-but-unregistered is printed to stderr and exits 1.
//
// stdout: one repo-relative path per FAILED file, so the caller can name them.
//
// Usage: node check-vitest-report.mjs <report.json> <registered-list.txt>
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const [reportPath, listPath] = process.argv.slice(2)
const root = resolve(import.meta.dirname, '../../..')

const registered = new Set(
  readFileSync(listPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((f) => relative(root, resolve(root, f)))
)

let results
try {
  results = JSON.parse(readFileSync(reportPath, 'utf8')).testResults
} catch (err) {
  console.error(`no readable vitest report at ${reportPath}: ${err.message}`)
  process.exit(1)
}

let ok = true
const reported = new Set()
for (const r of results) {
  const file = relative(root, r.name)
  if (reported.has(file)) {
    console.error(`reported twice: ${file}`)
    ok = false
  }
  reported.add(file)
  if (!registered.has(file)) {
    console.error(`reported but not registered: ${file}`)
    ok = false
  }
  if (r.status === 'failed') console.log(file)
}
for (const file of registered) {
  if (!reported.has(file)) {
    console.error(`registered but vitest reported no result (include glob? crash?): ${file}`)
    ok = false
  }
}
process.exit(ok ? 0 : 1)
