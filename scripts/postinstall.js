const { execFileSync, execSync } = require('child_process')
const { chmodSync, existsSync, readdirSync } = require('fs')
const { join } = require('path')

function walkFiles(dir, predicate, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(fullPath, predicate, out)
    else if (predicate(fullPath)) out.push(fullPath)
  }
  return out
}

function signDarwinNativeAddons() {
  if (process.platform !== 'darwin') return

  const roots = [
    join(__dirname, '..', 'node_modules', 'better-sqlite3', 'build'),
    join(__dirname, '..', 'node_modules', 'node-pty', 'build'),
  ]
  const addons = roots.flatMap((root) => walkFiles(root, (file) => file.endsWith('.node')))

  for (const addon of addons) {
    try {
      execFileSync('codesign', ['--force', '--sign', '-', addon], { stdio: 'ignore' })
    } catch {
      // Loading will fail loudly later; do not make install unusable on machines without codesign.
    }
  }
}

if (!process.env.CI_SKIP_POSTINSTALL && !process.env.CF_PAGES) {
  execSync('pnpm --filter @slayzone/app exec electron-rebuild -f -w better-sqlite3,node-pty', {
    stdio: 'inherit',
  })

  // pnpm can strip execute bits from prebuilt binaries — restore them
  // so node-pty's spawn-helper can be executed by posix_spawnp.
  const prebuildsDir = join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds')
  try {
    for (const platform of readdirSync(prebuildsDir)) {
      const dir = join(prebuildsDir, platform)
      for (const file of readdirSync(dir)) {
        if (file === 'spawn-helper') chmodSync(join(dir, file), 0o755)
      }
    }
  } catch {}

  signDarwinNativeAddons()
}
