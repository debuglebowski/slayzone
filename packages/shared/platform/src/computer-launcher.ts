/** Stable, dependency-free entrypoint pinned by computer service units. */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
export const COMPUTER_LAUNCHER = String.raw`#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const root = process.env.SLAYZONE_ROOT;
if (!root) throw Error('computer launcher requires SLAYZONE_ROOT');
const role = process.argv.includes('--session-host') ? 'host' : 'supervisor';
const dir = path.join(root, 'computer-runtime'), pointer = path.join(dir, role === 'host' ? 'host-release.json' : 'supervisor.json');
let child, stopping = false, healthy = false, timer, probation, killTimer;
function read() { return JSON.parse(fs.readFileSync(pointer, 'utf8')); }
function launch() {
  const state = read(); healthy = false; probation = undefined;
  child = cp.fork(state.current.entry, [role === 'host' ? '--session-host' : '--supervisor'], {env: {...process.env, SLAYZONE_NONINTERACTIVE:'1'}, stdio:['inherit','inherit','inherit','ipc']});
  timer = setTimeout(() => { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 10000); }, 90000);
  child.on('message', m => { if (m && m.type === 'supervisor-ready') {clearTimeout(timer); if (!probation) probation = setTimeout(() => {healthy = true;}, 60000);} });
  child.on('error', () => {});
  child.on('exit', (code) => {
    clearTimeout(timer); clearTimeout(probation); clearTimeout(killTimer);
    if (stopping) {process.exitCode = code || 0; return;}
    if (code === 75) {launch(); return;}
    if (!healthy && code !== 0 && state.previous) {
      fs.writeFileSync(path.join(dir, role + '-quarantine.json'), JSON.stringify({version: state.current.version, until: Date.now() + 900000}), {mode:0o600});
      const temp = pointer + '.tmp';
      fs.writeFileSync(temp, JSON.stringify({current:state.previous}) + '\n', {mode:0o600}); fs.renameSync(temp,pointer);
    }
    if (code === 0) return;
    setTimeout(launch, 2000);
  });
}
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {stopping = true; child?.kill(signal);});
launch();
`
export function ensureComputerLauncher(
  root: string,
  release: { entry: string; version: string },
  forceUpgrade = false
): string {
  const dir = join(root, 'computer-runtime')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const launcher = join(dir, 'launch.cjs')
  writeFileSync(launcher + '.tmp', COMPUTER_LAUNCHER, { mode: 0o700 })
  // Copy-on-replace, so a service opening the file never observes a partial script.
  // Use a static import here to keep the launcher independent of the platform barrel.
  renameLauncher(launcher)
  if (forceUpgrade) {
    for (const name of ['supervisor.json', 'host-release.json']) {
      const path = join(dir, name)
      let previous: unknown
      try {
        previous = JSON.parse(readPointer(path)).current
      } catch {
        /* Initial install. */
      }
      writeFileSync(
        path + '.tmp',
        JSON.stringify({ current: release, ...(previous ? { previous } : {}) }),
        { mode: 0o600 }
      )
      renameSync(path + '.tmp', path)
    }
  }
  const hostPointer = join(dir, 'host-release.json')
  if (!existsSync(hostPointer))
    writeFileSync(hostPointer, JSON.stringify({ current: release }), { mode: 0o600, flag: 'wx' })
  const pointer = join(dir, 'supervisor.json')
  if (!existsSync(pointer))
    writeFileSync(pointer, JSON.stringify({ current: release }), { mode: 0o600, flag: 'wx' })
  return launcher
}
import { renameSync, readFileSync } from 'node:fs'
function readPointer(path: string): string {
  return readFileSync(path, 'utf8')
}
function renameLauncher(path: string): void {
  renameSync(path + '.tmp', path)
}
