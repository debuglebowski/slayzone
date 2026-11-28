/** Stable, dependency-free entrypoint pinned by computer service units. */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  ENDPOINT_IN_USE_LISTEN_ERRORS,
  HOST_SUPERSEDED_NOTICE,
  LEGACY_HOST_SUPERSEDED_EXIT_CODE,
  UNIX_SOCKET_PATH_MAX_BYTES
} from './computer-endpoints'
export const COMPUTER_LAUNCHER = String.raw`#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const net = require('node:net'), os = require('node:os'), crypto = require('node:crypto');
const root = process.env.SLAYZONE_ROOT;
if (!root) throw Error('computer launcher requires SLAYZONE_ROOT');
const role = process.argv.includes('--session-host') ? 'host' : 'supervisor';
const dir = path.join(root, 'computer-runtime'), pointer = path.join(dir, role === 'host' ? 'host-release.json' : 'supervisor.json');
// Restart delay after consecutive failures: 2s doubling to 60s, reset once a child is healthy.
const BACKOFF_MIN_MS = 2000, BACKOFF_MAX_MS = 60000, LOG_MAX_BYTES = 5 * 1024 * 1024;
// A session host that found another live host on its control endpoint (computer-endpoints.ts
// HOST_SUPERSEDED_EXIT_CODE): it says so over IPC, then exits 0. A 0.44.0 host exited 79 instead.
const SUPERSEDED_NOTICE = ${JSON.stringify(HOST_SUPERSEDED_NOTICE)}, LEGACY_SUPERSEDED_EXIT = ${LEGACY_HOST_SUPERSEDED_EXIT_CODE};
// This root's endpoints, derived exactly as computer-endpoints.ts derives them.
const endpointKey = crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 24);
const endpointDir = process.platform === 'win32' ? null : path.join(os.tmpdir(), 'slay-computer-' + (process.getuid ? process.getuid() : 'user') + '-' + endpointKey);
const endpoints = endpointDir
  ? {control: path.join(endpointDir, 'control.sock'), launcher: path.join(endpointDir, 'l.sock')}
  : {control: '\\\\.\\pipe\\slay-computer-' + endpointKey, launcher: '\\\\.\\pipe\\slay-computer-launcher-' + endpointKey};
// Longest Unix socket path Node accepts (computer-endpoints.ts UNIX_SOCKET_PATH_MAX_BYTES):
// a longer one fails listen/connect with a bare EINVAL, so it is refused by name first.
const SOCKET_PATH_MAX = ${JSON.stringify(UNIX_SOCKET_PATH_MAX_BYTES)}[process.platform] || 104;
// listen errors meaning the endpoint path is already held (computer-endpoints.ts
// ENDPOINT_IN_USE_LISTEN_ERRORS): EADDRINUSE, or EEXIST when macOS sees another
// launcher bind the same path at the same moment. Either way: probe, never bail.
const IN_USE_LISTEN_ERRORS = ${JSON.stringify(ENDPOINT_IN_USE_LISTEN_ERRORS)};
function socketPathError(p) {
  const bytes = Buffer.byteLength(p);
  return bytes <= SOCKET_PATH_MAX ? null : 'computer endpoint ' + p + ' is ' + bytes + ' bytes, over the ' + SOCKET_PATH_MAX + '-byte Unix socket path limit on ' + process.platform + '; point TMPDIR at a shorter directory';
}
if (process.argv.includes('--print-endpoints')) { process.stdout.write(JSON.stringify(endpoints) + '\n'); return; }
let child, stopping = false, healthy = false, timer, probation, killTimer, failures = 0, nextTimer, lock;
// What a waiting supervisor asks over the launcher endpoint (queryHostLauncher).
const status = {state: 'starting', childPid: null, nextLaunchAt: null, lastExit: null};
function read() { return JSON.parse(fs.readFileSync(pointer, 'utf8')); }
// Every start and exit of the child, timestamped, to stderr and to logs/computer.log
// (shared by every computer process). Before, an exit left no trace at all here.
function log(msg) {
  const line = new Date().toISOString() + ' [launcher ' + process.pid + '] ' + role + ' ' + msg + '\n';
  try { process.stderr.write(line); } catch {}
  try { const logs = path.join(root, 'logs'); fs.mkdirSync(logs, {recursive: true, mode: 0o700}); fs.appendFileSync(path.join(logs, 'computer.log'), line, {mode: 0o600}); } catch {}
}
// The session host's launcher writes, for its whole life, to the host.log it was started
// with: rotated only when a host was spawned, it grew without bound (32 MB). Copy, then
// truncate in place: every holder of the file appends, so all keep writing to its start.
function rotateHostLog() {
  if (role !== 'host') return;
  try {
    const file = path.join(dir, 'host.log'), out = fs.fstatSync(1), st = fs.statSync(file);
    if (out.ino !== st.ino || out.dev !== st.dev || st.size <= LOG_MAX_BYTES) return;
    fs.copyFileSync(file, file + '.1'); fs.truncateSync(file, 0);
  } catch {}
}
setInterval(rotateHostLog, 600000).unref();
// ── One session-host launcher per root ──────────────────────────────────────────
// The launcher endpoint is held for this launcher's whole life: a second launcher for
// the root finds it live and stops before starting any child. (Two once ran at once,
// one restarting an EADDRINUSE-failing child forever, rolling back good releases.)
function prepareEndpointDir() {
  if (!endpointDir) return;
  try { fs.mkdirSync(endpointDir, {mode: 0o700}); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const st = fs.lstatSync(endpointDir);
  if (st.isSymbolicLink() || !st.isDirectory() || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077))
    throw Error('unsafe computer endpoint directory ' + endpointDir + ': must be a directory owned by this user with mode 0700');
}
// live / stale / absent as probeEndpoint (computer-endpoints.ts) tells them; any other
// connect error says nothing about an owner and is passed on (cb(null, err)).
function probe(cb) {
  const s = net.connect(endpoints.launcher); let done = false;
  const fin = (r, err) => { if (done) return; done = true; clearTimeout(t); s.destroy(); cb(r, err); };
  const t = setTimeout(() => fin('live'), 2000);
  s.once('connect', () => fin('live'));
  s.once('error', (e) => e.code === 'ENOENT' ? fin('absent') : e.code === 'ECONNREFUSED' ? fin('stale') : e.code === 'EAGAIN' ? fin('live') : fin(null, e));
}
function serveStatus(socket) {
  let buf = '';
  socket.setEncoding('utf8'); socket.on('error', () => {}); socket.setTimeout(2000, () => socket.destroy());
  socket.on('data', (chunk) => {
    buf += chunk; const end = buf.indexOf('\n');
    if (end < 0) { if (buf.length > 1024) socket.destroy(); return; }
    let command; try { command = JSON.parse(buf.slice(0, end)).command; } catch {}
    if (command === 'launch-now' && status.state === 'backoff' && !stopping) { clearTimeout(nextTimer); log('launching now, at a waiting supervisor\'s request'); launch(); }
    socket.end(JSON.stringify(status) + '\n');
  });
}
function bail(msg) { log(msg + '; stopping'); process.exit(1); }
// Every bind of the launcher endpoint happens inside one short critical section (an
// atomic mkdir of the guard). listen() on a Unix socket is bind() then listen(): in
// between, the file exists but refuses connections, exactly like one whose launcher
// died. With binds serialized, a refusing socket seen while holding the guard can only
// be a dead launcher's, so replacing it is safe. (2026-11-27: under full CPU load a
// launcher probed a winner preempted in that gap, "took over" its live endpoint, and
// two launchers each ran a host.) Windows: named pipes are exclusive; no guard needed.
// The guard keeps its old name so an older launcher.cjs still running excludes with it.
const GUARD_STALE_MS = 10000;
function acquire(then, attempt) {
  attempt = attempt || 0;
  if (attempt > 50) return bail('cannot take the launcher endpoint ' + endpoints.launcher);
  if (endpointDir) { const tooLong = socketPathError(endpoints.launcher) || socketPathError(endpoints.control); if (tooLong) return bail(tooLong); }
  try { prepareEndpointDir(); } catch (e) { return bail(e.message); }
  const retry = (ms) => setTimeout(() => acquire(then, attempt + 1), ms);
  const guard = endpointDir ? endpoints.launcher + '.takeover' : null;
  if (guard) {
    try { fs.mkdirSync(guard, {mode: 0o700}); } catch (e) {
      // ENOENT: a launcher exiting just removed the (empty) endpoint directory.
      if (e.code === 'ENOENT') return retry(0);
      if (e.code !== 'EEXIST') return bail('cannot take ' + guard + ': ' + e.message);
      // Held for a bind (milliseconds). Waiting on it is not a failed attempt: it ends
      // when the holder finishes, or GUARD_STALE_MS after a holder that died holding it.
      try { if (Date.now() - fs.statSync(guard).mtimeMs > GUARD_STALE_MS) fs.rmdirSync(guard); } catch {}
      return setTimeout(() => acquire(then, attempt), 25);
    }
  }
  const unguard = () => { if (guard) try { fs.rmdirSync(guard); } catch {} };
  const won = (server, how) => { unguard(); if (how) log(how); lock = server; then(); };
  const server = net.createServer(serveStatus);
  server.once('error', (err) => {
    if (!IN_USE_LISTEN_ERRORS.includes(err.code)) { unguard(); return bail('cannot bind ' + endpoints.launcher + ': ' + err.message); }
    probe((state, probeErr) => {
      if (probeErr) { unguard(); return bail('cannot probe ' + endpoints.launcher + ': ' + (probeErr.code || probeErr.message)); }
      if (state === 'live') { unguard(); log('launcher already running for this root; superseded, stopping'); process.exit(0); }
      if (state === 'absent' || !guard) { unguard(); return retry(50); }
      // Stale: its launcher died (no live one binds without the guard this one holds).
      try { fs.unlinkSync(endpoints.launcher); } catch {}
      const taken = net.createServer(serveStatus);
      taken.once('error', () => { unguard(); retry(0); });
      taken.listen(endpoints.launcher, () => won(taken, 'took over a launcher endpoint left by a dead launcher'));
    });
  });
  server.listen(endpoints.launcher, () => won(server));
}
// Ends this launcher: frees its endpoint (and the directory, once empty), then exits.
function release(code) {
  status.state = 'stopping'; status.nextLaunchAt = null; clearTimeout(nextTimer);
  process.exitCode = code;
  if (!lock) return;
  lock.close(() => { if (endpointDir) try { fs.rmdirSync(endpointDir); } catch {} });
  lock = undefined;
}
function launch() {
  if (stopping) return;
  rotateHostLog();
  const state = read(); let timedOut = false, superseded = false; healthy = false; probation = undefined;
  const startedAt = Date.now();
  child = cp.fork(state.current.entry, [role === 'host' ? '--session-host' : '--supervisor'], {env: {...process.env, SLAYZONE_NONINTERACTIVE:'1'}, stdio:['inherit','inherit','inherit','ipc']});
  status.state = 'running'; status.childPid = child.pid; status.nextLaunchAt = null;
  log(state.current.version + ' started pid=' + child.pid + (failures ? ' (after ' + failures + ' consecutive failures)' : ''));
  timer = setTimeout(() => {
    timedOut = true;
    log(state.current.version + ' startup timed out; restarting');
    // A supervisor SIGTERM means explicit shutdown, including its persistent host.
    // Crash only the supervisor; its connectors stop on IPC loss and work survives.
    if (role === 'supervisor') child.kill('SIGKILL');
    else { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 10000); }
  }, 90000);
  child.on('message', m => { if (m && m.type === SUPERSEDED_NOTICE) superseded = true; if (m && m.type === 'supervisor-ready') {clearTimeout(timer); if (!probation) probation = setTimeout(() => {healthy = true; failures = 0;}, 60000);} });
  child.on('error', (err) => { log(state.current.version + ' child error: ' + (err && err.message)); });
  child.on('exit', (code, signal) => {
    clearTimeout(timer); clearTimeout(probation); clearTimeout(killTimer);
    // A clean exit may still have its last IPC message (the superseded notice) unread:
    // read the channel to its end first, bounded (a grandchild could hold it open).
    if (code !== 0 || !child.connected) return exited(code, signal);
    let settled = false;
    const settle = () => { if (settled) return; settled = true; clearTimeout(drain); exited(code, signal); };
    const drain = setTimeout(settle, 1000);
    child.once('disconnect', settle);
  });
  function exited(code, signal) {
    const ended = state.current.version + ' pid=' + child.pid + ' exited code=' + code + ' signal=' + signal + ' after ' + (Date.now() - startedAt) + 'ms';
    status.childPid = null; status.lastExit = {version: state.current.version, code, signal, at: Date.now()};
    if (stopping) {log(ended + '; stopping'); release(code || 0); return;}
    // Another live host owns the endpoint: not a failure of this release (no
    // quarantine, no rollback), and nothing to restart. This launcher is redundant.
    if (role === 'host' && !timedOut && ((superseded && code === 0) || code === LEGACY_SUPERSEDED_EXIT)) {log(ended + '; superseded by a live session host, stopping'); stopping = true; release(0); return;}
    if (code === 75 && !timedOut) {log(ended + '; relaunching (requested)'); launch(); return;}
    const failed = timedOut || code !== 0;
    let rolledBack = '';
    if (!healthy && failed && state.previous) {
      fs.writeFileSync(path.join(dir, role + '-quarantine.json'), JSON.stringify({version: state.current.version, until: Date.now() + 900000}), {mode:0o600});
      const temp = pointer + '.tmp';
      fs.writeFileSync(temp, JSON.stringify({current:state.previous}) + '\n', {mode:0o600}); fs.renameSync(temp,pointer);
      rolledBack = '; quarantined, rolled back to ' + state.previous.version;
    }
    if (!failed) {log(ended + '; not restarting'); release(0); return;}
    failures += 1;
    const delay = Math.min(BACKOFF_MIN_MS * Math.pow(2, failures - 1), BACKOFF_MAX_MS);
    log(ended + rolledBack + '; restarting in ' + delay + 'ms (failure ' + failures + ')');
    status.state = 'backoff'; status.nextLaunchAt = Date.now() + delay;
    nextTimer = setTimeout(launch, delay);
  }
}
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {
  stopping = true; log('received ' + signal + ', stopping');
  // No child up (backing off, or not started yet): nothing to wait for.
  if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
  else release(0);
});
if (role === 'host') acquire(() => (stopping ? release(0) : launch()));
else launch();
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
