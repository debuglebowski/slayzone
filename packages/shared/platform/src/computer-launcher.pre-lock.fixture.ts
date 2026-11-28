/**
 * The session-host launcher every release up to 0.43.0 wrote (computer-launcher.ts as of
 * v0.43.0, verbatim). Its processes outlive the upgrade that replaces the file: a
 * computer upgraded from 0.43.0 or earlier still runs it, in memory, for its live host
 * and for any redundant launcher a supervisor once spawned. It restarts every non-zero
 * child exit after a fixed 2s, rolling the release back (and quarantining it) first
 * when the child never became healthy; a zero exit ends it. Whatever a session host
 * does when superseded must stop THIS launcher too.
 */
export const PRE_LOCK_COMPUTER_LAUNCHER = String.raw`#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const root = process.env.SLAYZONE_ROOT;
if (!root) throw Error('computer launcher requires SLAYZONE_ROOT');
const role = process.argv.includes('--session-host') ? 'host' : 'supervisor';
const dir = path.join(root, 'computer-runtime'), pointer = path.join(dir, role === 'host' ? 'host-release.json' : 'supervisor.json');
let child, stopping = false, healthy = false, timer, probation, killTimer;
function read() { return JSON.parse(fs.readFileSync(pointer, 'utf8')); }
function launch() {
  if (stopping) return;
  const state = read(); let timedOut = false; healthy = false; probation = undefined;
  child = cp.fork(state.current.entry, [role === 'host' ? '--session-host' : '--supervisor'], {env: {...process.env, SLAYZONE_NONINTERACTIVE:'1'}, stdio:['inherit','inherit','inherit','ipc']});
  timer = setTimeout(() => {
    timedOut = true;
    process.stderr.write('[computer-launcher] ' + role + ' ' + state.current.version + ' startup timed out; restarting\n');
    // A supervisor SIGTERM means explicit shutdown, including its persistent host.
    // Crash only the supervisor; its connectors stop on IPC loss and work survives.
    if (role === 'supervisor') child.kill('SIGKILL');
    else { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 10000); }
  }, 90000);
  child.on('message', m => { if (m && m.type === 'supervisor-ready') {clearTimeout(timer); if (!probation) probation = setTimeout(() => {healthy = true;}, 60000);} });
  child.on('error', () => {});
  child.on('exit', (code) => {
    clearTimeout(timer); clearTimeout(probation); clearTimeout(killTimer);
    if (stopping) {process.exitCode = code || 0; return;}
    if (code === 75 && !timedOut) {launch(); return;}
    const failed = timedOut || code !== 0;
    if (!healthy && failed && state.previous) {
      fs.writeFileSync(path.join(dir, role + '-quarantine.json'), JSON.stringify({version: state.current.version, until: Date.now() + 900000}), {mode:0o600});
      const temp = pointer + '.tmp';
      fs.writeFileSync(temp, JSON.stringify({current:state.previous}) + '\n', {mode:0o600}); fs.renameSync(temp,pointer);
    }
    if (!failed) return;
    setTimeout(launch, 2000);
  });
}
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {stopping = true; child?.kill(signal);});
launch();
`
