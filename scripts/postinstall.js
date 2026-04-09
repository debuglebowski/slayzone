const { execSync } = require('child_process')
const { chmodSync, readdirSync } = require('fs')
const { join } = require('path')

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
}
