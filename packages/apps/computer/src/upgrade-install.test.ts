import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { installComputerRelease, releaseEntry } from './upgrade-runtime'

let root: string | undefined
afterEach(() => {
  vi.unstubAllEnvs()
  if (root) rmSync(root, { recursive: true, force: true })
})

it('failed registry install leaves enrollment/config intact and retries exact hub version into isolated prefix', async () => {
  root = mkdtempSync(join(tmpdir(), 'computer-upgrade-install-'))
  const state = join(root, 'computer.state.json')
  const config = join(root, 'computer.config.json')
  writeFileSync(state, '{"enrollment":"keep"}')
  writeFileSync(config, '{"allowedRoots":["/srv/work"]}')
  const runtime = join(root, 'computer-runtime')
  const marker = join(root, 'fail')
  writeFileSync(marker, '')
  const npm = join(root, 'npm')
  writeFileSync(
    npm,
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const argv = process.argv.slice(2);
if (!argv.includes('@slayzone/computer@2.0.0-beta.1')) process.exit(2);
if (fs.existsSync(${JSON.stringify(marker)})) process.exit(1);
const prefix = argv[argv.indexOf('--prefix') + 1];
const entry = path.join(prefix, 'node_modules/@slayzone/computer/dist/bin.cjs');
fs.mkdirSync(path.dirname(entry), {recursive:true});
fs.writeFileSync(entry, ${JSON.stringify("process.stdout.write('2.0.0-beta.1')")});
`
  )
  chmodSync(npm, 0o755)
  vi.stubEnv('PATH', `${root}${delimiter}${process.env.PATH}`)
  await expect(installComputerRelease(runtime, '2.0.0-beta.1')).rejects.toThrow()
  expect(existsSync(releaseEntry(runtime, '2.0.0-beta.1'))).toBe(false)
  rmSync(marker)
  const entry = await installComputerRelease(runtime, '2.0.0-beta.1')
  expect(entry).toBe(releaseEntry(runtime, '2.0.0-beta.1'))
  expect(readFileSync(state, 'utf8')).toBe('{"enrollment":"keep"}')
  expect(readFileSync(config, 'utf8')).toBe('{"allowedRoots":["/srv/work"]}')
  // A partial/corrupt cache must not poison all later automatic attempts.
  writeFileSync(entry, 'process.exit(1)')
  await expect(installComputerRelease(runtime, '2.0.0-beta.1')).resolves.toBe(entry)
})

it('never repairs a corrupt cache in place while a host or another hub uses it', async () => {
  const { mkdirSync } = await import('node:fs')
  root = mkdtempSync(join(tmpdir(), 'computer-live-release-'))
  const runtime = join(root, 'computer-runtime')
  const npm = join(root, 'npm')
  writeFileSync(npm, '#!/usr/bin/env node\nprocess.exit(1)')
  vi.stubEnv('PATH', `${root}${delimiter}${process.env.PATH}`)
  const entry = releaseEntry(runtime, '2.0.0')
  mkdirSync(join(entry, '..'), { recursive: true })
  writeFileSync(entry, 'process.exit(1)')
  await expect(
    installComputerRelease(runtime, '2.0.0', undefined, (active) => active === entry)
  ).rejects.toThrow('in use')
  expect(readFileSync(entry, 'utf8')).toBe('process.exit(1)')
})
