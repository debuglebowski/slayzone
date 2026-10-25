const { execSync } = require('child_process')
const { chmodSync, readdirSync } = require('fs')
const { join } = require('path')
const { signDevElectron } = require('./sign-dev-electron')

if (!process.env.CI_SKIP_POSTINSTALL && !process.env.CF_PAGES) {
  // Since Electron 42 the npm package no longer downloads its binary on install;
  // it downloads on the first `require('electron')`. Resolve it here so the binary
  // (and node_modules/electron/path.txt, which tests and the CLI read directly)
  // exists before electron-rebuild and every consumer. A no-op once present, and
  // it honours a renamed bundle from scripts/patch-electron-name.js.
  require(
    require.resolve('electron', { paths: [join(__dirname, '..', 'packages', 'apps', 'app')] })
  )
  signDevElectron()

  execSync('pnpm --filter @slayzone/app exec electron-rebuild -f -w better-sqlite3,node-pty', {
    stdio: 'inherit'
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
}
