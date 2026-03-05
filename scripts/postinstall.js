const { execSync } = require('child_process')

if (!process.env.CI_SKIP_POSTINSTALL) {
  execSync('pnpm --filter @slayzone/app exec electron-rebuild -f -w better-sqlite3,node-pty', {
    stdio: 'inherit',
  })
}
