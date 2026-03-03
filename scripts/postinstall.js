const { spawnSync } = require("node:child_process");

const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(
  pnpmCmd,
  ["--filter", "@slayzone/app", "exec", "electron-rebuild"],
  { stdio: "inherit", shell: false }
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
