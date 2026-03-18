import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'

export interface CliInstallResult {
  ok: boolean
  path?: string
  permissionDenied?: boolean
  error?: string
  pathNotInPATH?: boolean
}

export function getCliBinDir(): string {
  switch (process.platform) {
    case 'darwin':
      return '/usr/local/bin'
    case 'win32':
      return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'SlayZone', 'bin')
    default:
      return path.join(os.homedir(), '.local', 'bin')
  }
}

export function getCliBinTarget(): string {
  const name = process.platform === 'win32' ? 'slay.cmd' : 'slay'
  return path.join(getCliBinDir(), name)
}

export function checkCliInstalled(): { installed: boolean; path?: string } {
  const target = getCliBinTarget()
  if (fs.existsSync(target)) return { installed: true, path: target }
  return { installed: false }
}

export function installCli(cliSrcPath: string): CliInstallResult {
  const binDir = getCliBinDir()
  const target = getCliBinTarget()

  try {
    fs.mkdirSync(binDir, { recursive: true })

    if (process.platform === 'win32') {
      return installWindows(cliSrcPath, binDir, target)
    } else {
      return installUnix(cliSrcPath, target, binDir)
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EACCES') {
      return { ok: false, permissionDenied: true, error: getManualInstallHint(cliSrcPath) }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function installUnix(cliSrcPath: string, target: string, binDir: string): CliInstallResult {
  if (!fs.existsSync(cliSrcPath)) {
    return { ok: false, error: `CLI source not found: ${cliSrcPath}` }
  }
  if (fs.existsSync(target)) fs.unlinkSync(target)
  fs.symlinkSync(cliSrcPath, target)
  const notInPath = !isBinDirInPath(binDir)
  return { ok: true, path: target, pathNotInPATH: notInPath || undefined }
}

function installWindows(cliSrcPath: string, binDir: string, target: string): CliInstallResult {
  if (!fs.existsSync(cliSrcPath)) {
    return { ok: false, error: `CLI source not found: ${cliSrcPath}` }
  }
  // Copy slay.js next to the .cmd shim
  // TODO: In dev mode, slay.js is at ../cli/dist/slay.js, not ../cli/bin/slay.js — shim won't work in dev on Windows
  const srcJs = cliSrcPath.replace(/[/\\]slay$/, path.sep + 'slay.js')
  const destJs = path.join(binDir, 'slay.js')
  if (fs.existsSync(srcJs)) {
    fs.copyFileSync(srcJs, destJs)
  }

  // Write .cmd shim that detects Node version for --experimental-sqlite
  // TODO: remove --experimental-sqlite when Node 22 is no longer supported
  const shimContent = [
    '@echo off',
    'for /f "tokens=1 delims=." %%v in (\'node -e "process.stdout.write(process.versions.node)"\') do set NODE_MAJOR=%%v',
    'if %NODE_MAJOR% LEQ 22 (',
    '  node --experimental-sqlite --no-warnings "%~dp0slay.js" %*',
    ') else (',
    '  node --no-warnings "%~dp0slay.js" %*',
    ')',
    ''
  ].join('\r\n')
  fs.writeFileSync(target, shimContent)

  // Add to user PATH via registry if not already present
  const notInPath = !isBinDirInPath(binDir)
  if (notInPath) {
    addToWindowsPath(binDir)
  }

  return { ok: true, path: target, pathNotInPATH: notInPath || undefined }
}

function isBinDirInPath(binDir: string): boolean {
  const envPath = process.env.PATH ?? ''
  const sep = process.platform === 'win32' ? ';' : ':'
  return envPath.split(sep).some(p => {
    try { return fs.realpathSync(p) === fs.realpathSync(binDir) } catch { return p === binDir }
  })
}

function addToWindowsPath(binDir: string): void {
  try {
    // Read current user PATH from registry
    const output = execSync('reg query "HKCU\\Environment" /v Path', { encoding: 'utf8' })
    const match = output.match(/Path\s+REG_\w+\s+(.*)/)
    const currentPath = match?.[1]?.trim() ?? ''

    // Check if already present
    if (currentPath.split(';').some(p => p.toLowerCase() === binDir.toLowerCase())) return

    const newPath = currentPath ? `${currentPath};${binDir}` : binDir
    execSync(`reg add "HKCU\\Environment" /v Path /t REG_EXPAND_SZ /d "${newPath}" /f`, { encoding: 'utf8' })

    // Broadcast WM_SETTINGCHANGE so new terminals pick up the change
    try {
      execSync('setx SLAYZONE_PATH_UPDATED 1 >nul 2>&1', { encoding: 'utf8' })
      execSync('reg delete "HKCU\\Environment" /v SLAYZONE_PATH_UPDATED /f >nul 2>&1', { encoding: 'utf8' })
    } catch {
      // Best effort — WM_SETTINGCHANGE is also triggered by reg add
    }
  } catch {
    // Non-fatal — user can add to PATH manually
  }
}

export function getManualInstallHint(cliSrcPath: string): string {
  switch (process.platform) {
    case 'darwin':
      return `sudo ln -sf "${cliSrcPath}" /usr/local/bin/slay`
    case 'win32':
      return `Copy slay.js and slay.cmd to a directory in your PATH`
    default:
      return `ln -sf "${cliSrcPath}" ~/.local/bin/slay`
  }
}
