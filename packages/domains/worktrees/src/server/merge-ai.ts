import { spawn } from 'child_process'
import { homedir, platform } from 'os'

export async function runAiCommand(mode: 'claude-code' | 'codex', prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const claudePath = platform() === 'win32' ? 'claude' : `${homedir()}/.local/bin/claude`
    const cmd = mode === 'claude-code' ? claudePath : 'codex'
    const args = mode === 'claude-code' ? ['--print', '--allow-dangerously-skip-permissions', prompt] : [prompt]

    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let error = ''

    proc.stdout?.on('data', (d) => { output += d.toString() })
    proc.stderr?.on('data', (d) => { error += d.toString() })

    proc.on('close', (code) => {
      if (code === 0) resolve(output.trim())
      else reject(new Error(error || `Exit code ${code}`))
    })

    proc.on('error', reject)

    // 60s timeout for conflict analysis
    const timeout = setTimeout(() => {
      proc.kill()
      reject(new Error('Timeout'))
    }, 60000)

    proc.on('close', () => clearTimeout(timeout))
  })
}
