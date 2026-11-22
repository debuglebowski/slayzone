import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = await mkdtemp(join(tmpdir(), 'slayzone-spatial-'))
const workDir = join(root, 'project')
const computerRoot = join(root, 'computer')
const address = '127.0.0.1:3000'
const origin = `http://${address}`
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('SLAYZONE_'))
)
const children = []
const shutdown = new AbortController()

function start(component, overrides, pipeOutput = false) {
  const binary = new URL(`../${component}/dist/bin.cjs`, import.meta.url)
  const child = spawn(process.execPath, [fileURLToPath(binary)], {
    env: { ...env, SLAYZONE_NONINTERACTIVE: '1', ...overrides },
    stdio: ['ignore', pipeOutput ? 'pipe' : 'inherit', 'inherit']
  })
  const finished = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve(`${component} exited (${code ?? signal})`))
    child.once('error', (error) => resolve(`${component}: ${error.message}`))
  })
  children.push({ child, finished })
  return { child, finished }
}

async function request(path, body) {
  const response = await fetch(`${origin}${path}`, {
    signal: shutdown.signal,
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
  })
  const result = await response.json()
  if (!response.ok) throw new Error(`${path}: ${result.error ?? response.status}`)
  return result.data ?? result
}

function stop() {
  shutdown.abort()
  for (const { child } of children) child.kill('SIGTERM')
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)

try {
  await mkdir(workDir)
  await mkdir(computerRoot)
  await writeFile(
    join(computerRoot, 'computer.config.json'),
    JSON.stringify({ computerName: 'Spatial Demo', allowedRoots: [workDir] })
  )
  const hub = start(
    'hub',
    {
      SLAYZONE_ROOT: join(root, 'hub'),
      SLAYZONE_HUB_LISTEN_ADDRESS: address
    },
    true
  )
  const lines = createInterface({ input: hub.child.stdout })
  const listening = new Promise((resolve) => {
    lines.on('line', (line) => {
      if (!line.startsWith('Migration ')) console.log(line)
      if (line.startsWith(`[slayzone-server] listening on ${origin} `)) resolve(true)
    })
  })
  const ready = await Promise.race([listening, hub.finished])
  if (ready !== true) throw new Error(ready)

  const { token, hubUrl } = await request('/api/computers/join-token', { label: 'Spatial Demo' })
  const worker = start('computer', {
    SLAYZONE_ROOT: computerRoot,
    SLAYZONE_HUB_ADDRESS: new URL(hubUrl).host,
    SLAYZONE_HUB_JOIN_TOKEN: token
  })
  const connected = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const computers = await request('/api/computers')
      const computer = computers.find((item) => item.connected && item.usable)
      if (computer) return computer
      await delay(250, undefined, { signal: shutdown.signal })
    }
    throw new Error('The demo computer did not connect.')
  }
  const computer = await Promise.race([connected(), worker.finished])
  if (typeof computer === 'string') throw new Error(computer)
  const project = await request('/api/projects', {
    name: 'Spatial Demo',
    path: workDir,
    computerId: computer.id
  })
  for (const title of ['Test the live terminal', 'Compare another task window']) {
    await request('/api/tasks', {
      title,
      projectId: project.id,
      agentId: 'terminal',
      description: 'Try opening the terminal and task details in their own windows.'
    })
  }
  console.log(`\nSpatial Demo ready at ${origin}\nDemo data: ${root}\nPress Ctrl+C to stop.\n`)
  const exited = await Promise.race(children.map(({ finished }) => finished))
  if (!shutdown.signal.aborted) throw new Error(exited)
} catch (error) {
  if (!shutdown.signal.aborted) {
    console.error(error.message)
    process.exitCode = 1
  }
} finally {
  stop()
  await Promise.all(children.map(({ finished }) => finished))
}
