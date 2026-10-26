/**
 * `slay computer roots` (T-27): the device-local way to change a computer's folder
 * limits now that a hub can no longer push them. Pins the edit rules — removals,
 * de-duplicated additions, a missing folder reported rather than saved. The running
 * computer's pickup of the file is covered in the computer app's own suite
 * (`hardening.test.ts`). Pure → plain tsx.
 */
import { editAllowedRoots } from './computer'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`)
  }
}

const exists = (d: string): boolean => d !== '/nope'

const added = editAllowedRoots(['/a'], { add: ['/b', '/a'], remove: [], exists })
check(
  'adds a folder once, keeps order',
  JSON.stringify(added.roots) === '["/a","/b"]',
  JSON.stringify(added)
)
check('nothing missing', added.missing.length === 0)

const removed = editAllowedRoots(['/a', '/b'], { add: [], remove: ['/a'], exists })
check('removes a folder', JSON.stringify(removed.roots) === '["/b"]', JSON.stringify(removed))

const swapped = editAllowedRoots(['/a'], { add: ['/c'], remove: ['/a'], exists })
check('remove then add', JSON.stringify(swapped.roots) === '["/c"]', JSON.stringify(swapped))

const missing = editAllowedRoots(['/a'], { add: ['/nope'], remove: [], exists })
check('reports a folder that does not exist', JSON.stringify(missing.missing) === '["/nope"]')

const emptied = editAllowedRoots(['/a'], { add: [], remove: ['/a'], exists })
check('can compute an empty set (the command refuses to save it)', emptied.roots.length === 0)

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
