/**
 * Every jail escape a reviewer found (rounds 1–4), driven through the REAL entry
 * points — fs., git.op and agentConfig.fs — against one layout: an allowed root `r`
 * and, beside it, a folder `o` the hub must never write into. Each case passes when
 * the call is refused or lands inside `r`; it fails when anything appears in `o`.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubToComputerMethods as M } from '@slayzone/computer-transport/shared'
import type { ComputerConfig } from '../config'
import { createAgentConfigHandlers } from './agent-config'
import { createFsHandlers } from './fs'
import { createGitOpHandlers } from './git-op'
import type { HubMethodTable } from './types'
import { setProtectedPaths } from '../path-jail'

let base: string
let r: string
let o: string
let fs: HubMethodTable
let gitOp: HubMethodTable
let agent: HubMethodTable

const ctx = (): { dialer: { notify: () => boolean }; config: ComputerConfig; log: () => void } => ({
  dialer: { notify: () => true },
  config: { hubUrl: 'ws://localhost:0/computers', name: 't', allowedRoots: [r], capabilities: [] },
  log: () => {}
})

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'jail-escapes-')))
  r = join(base, 'r')
  o = join(base, 'o')
  mkdirSync(r)
  mkdirSync(join(o, 'dir'), { recursive: true })
  fs = createFsHandlers(ctx()).handlers
  gitOp = createGitOpHandlers(ctx())
  agent = createAgentConfigHandlers(ctx(), () => join(base, 'home'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

/** Everything under `o`, so a case can assert nothing new appeared there. */
const outsideEntries = (): string[] => {
  const out: string[] = []
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      out.push(`${rel}${name.name}`)
      if (name.isDirectory()) walk(join(d, name.name), `${rel}${name.name}/`)
    }
  }
  walk(o, '')
  return out.sort()
}

async function attempt(fn: () => unknown): Promise<'refused' | 'ok'> {
  try {
    await fn()
    return 'ok'
  } catch {
    return 'refused'
  }
}

/** Run `fn` and assert it wrote nothing outside the root, whatever it answered. */
async function nothingOutside(fn: () => unknown): Promise<'refused' | 'ok'> {
  const before = outsideEntries()
  const result = await attempt(fn)
  expect(outsideEntries(), 'nothing new outside the root').toEqual(before)
  return result
}

describe('G1: root/miss/../l with l a dangling link out', () => {
  beforeEach(() => symlinkSync(join(o, 'secret.txt'), join(r, 'l')))

  it('fs.createFile', async () => {
    expect(
      await nothingOutside(() => fs[M.fsCreateFile]({ rootPath: r, filePath: 'miss/../l' }))
    ).toBe('refused')
  })

  it('fs.writeFile', async () => {
    await nothingOutside(() =>
      fs[M.fsWriteFile]({ rootPath: r, filePath: 'miss/../l', content: 'x' })
    )
  })

  it('fs.copy (it aborted the computer in cpSync)', async () => {
    writeFileSync(join(r, 'src.txt'), 'x')
    await nothingOutside(() =>
      fs[M.fsCopy]({ rootPath: r, srcPath: 'src.txt', destPath: 'miss/../l' })
    )
  })

  it('git.op writeResolvedFile', async () => {
    execFileSync('git', ['init', '-q'], { cwd: r })
    await nothingOutside(() =>
      gitOp[M.gitOp]({
        op: 'writeResolvedFile',
        input: { repoPath: r, filePath: 'miss/../l', content: 'x' }
      })
    )
  })

  it('agentConfig.fs writeFile', async () => {
    await nothingOutside(() =>
      agent[M.agentConfigFs]({ op: 'writeFile', path: `${r}/miss/../l`, content: 'x' })
    )
  })
})

describe('G4: copy-in onto a dangling link inside the root', () => {
  it('fs.copyIn writes a new file in the root, never through the link', async () => {
    mkdirSync(join(r, 'incoming'))
    writeFileSync(join(r, 'incoming', 'l'), 'payload')
    symlinkSync(join(o, 'x.plist'), join(r, 'l'))
    const res = await nothingOutside(() =>
      fs[M.fsCopyIn]({ rootPath: r, absoluteSrc: join(r, 'incoming', 'l') })
    )
    expect(res).toBe('ok')
    expect(existsSync(join(r, 'l (1)'))).toBe(true)
  })

  it('fs.copyIn into a target folder that is a link out', async () => {
    writeFileSync(join(r, 'f.txt'), 'payload')
    symlinkSync(join(o, 'dir'), join(r, 'linked'))
    expect(
      await nothingOutside(() =>
        fs[M.fsCopyIn]({ rootPath: r, absoluteSrc: join(r, 'f.txt'), targetDir: 'linked' })
      )
    ).toBe('refused')
  })
})

describe('earlier rounds, through fs.writeFile', () => {
  const write = (filePath: string) => () =>
    fs[M.fsWriteFile]({ rootPath: r, filePath, content: 'x' })

  it('..', async () => {
    expect(await nothingOutside(write('../o/f'))).toBe('refused')
  })

  it('absolute', async () => {
    expect(await nothingOutside(write(join(o, 'f')))).toBe('refused')
  })

  it('a link to a folder out', async () => {
    symlinkSync(join(o, 'dir'), join(r, 'x'))
    expect(await nothingOutside(write('x/f'))).toBe('refused')
  })

  it('a link reached through a link (F3 #1)', async () => {
    symlinkSync(join(o, 'dir'), join(r, 'x'))
    symlinkSync('../secret', join(o, 'dir', 'f'))
    expect(await nothingOutside(write('x/f'))).toBe('refused')
  })

  it('`..` after a link (F3 #2): lands inside, as judged', async () => {
    symlinkSync(join(o, 'dir'), join(r, 's'))
    await nothingOutside(write('s/../y'))
  })

  it('a dangling link out (R9)', async () => {
    symlinkSync(join(o, 'new'), join(r, 'd'))
    expect(await nothingOutside(write('d'))).toBe('refused')
  })

  it.skipIf(process.platform === 'win32')(
    'POSIX backslash and UNC forms are names inside the root (F3 follow-up, G2)',
    async () => {
      expect(await nothingOutside(write('..\\o\\f'))).toBe('ok')
      expect(await nothingOutside(write('\\\\srv\\share\\..\\..\\o\\f'))).toBe('ok')
    }
  )

  it('a NUL byte', async () => {
    expect(await nothingOutside(write('a\0b'))).toBe('refused')
  })
})

describe('deletes and renames act on the entry, never through a link', () => {
  it('fs.delete of a link removes the link, not its target', async () => {
    writeFileSync(join(o, 'dir', 'keep'), 'x')
    symlinkSync(join(o, 'dir'), join(r, 'x'))
    expect(await attempt(() => fs[M.fsDelete]({ rootPath: r, targetPath: 'x' }))).toBe('ok')
    expect(existsSync(join(o, 'dir', 'keep'))).toBe(true)
    expect(existsSync(join(r, 'x'))).toBe(false)
  })

  it('fs.delete through a link to a folder out is refused', async () => {
    writeFileSync(join(o, 'dir', 'keep'), 'x')
    symlinkSync(join(o, 'dir'), join(r, 'x'))
    expect(await attempt(() => fs[M.fsDelete]({ rootPath: r, targetPath: 'x/keep' }))).toBe(
      'refused'
    )
    expect(existsSync(join(o, 'dir', 'keep'))).toBe(true)
  })

  it('fs.rename into a link to a folder out is refused', async () => {
    writeFileSync(join(r, 'a'), 'x')
    symlinkSync(join(o, 'dir'), join(r, 'x'))
    expect(
      await nothingOutside(() => fs[M.fsRename]({ rootPath: r, oldPath: 'a', newPath: 'x/a' }))
    ).toBe('refused')
  })
})

// Round-5 K2: the computer's own state, protected by NAME, was let through in a
// different letter case or Unicode form — on APFS / NTFS the same file. `fs.delete
// '.STATE'` took the whole state folder. Protected by identity (and a folded name
// for what does not exist yet), through the real handlers.
describe.skipIf(process.platform === 'linux')(
  'K2: the computer’s own state in any spelling',
  () => {
    beforeEach(() => {
      mkdirSync(join(r, '.state'))
      writeFileSync(join(r, '.state', 'computer.config.json'), '{"keep":true}')
      writeFileSync(join(r, '.state', 'café.json'), 'keep')
      setProtectedPaths([join(r, '.state')])
    })
    afterEach(() => setProtectedPaths([]))

    const kept = () =>
      existsSync(join(r, '.state', 'computer.config.json')) &&
      readFileSync(join(r, '.state', 'computer.config.json'), 'utf-8') === '{"keep":true}'

    it('fs.delete of `.STATE` is refused; the state folder survives', async () => {
      expect(await attempt(() => fs[M.fsDelete]({ rootPath: r, targetPath: '.STATE' }))).toBe(
        'refused'
      )
      expect(kept()).toBe(true)
    })

    it('fs.writeFile to `.state/COMPUTER.CONFIG.JSON` is refused', async () => {
      expect(
        await attempt(() =>
          fs[M.fsWriteFile]({ rootPath: r, filePath: '.State/COMPUTER.CONFIG.JSON', content: 'x' })
        )
      ).toBe('refused')
      expect(kept()).toBe(true)
    })

    it('an NFD spelling of an NFC name is refused', async () => {
      expect(
        await attempt(() =>
          fs[M.fsWriteFile]({ rootPath: r, filePath: '.state/café.json', content: 'x' })
        )
      ).toBe('refused')
      expect(readFileSync(join(r, '.state', 'café.json'), 'utf-8')).toBe('keep')
    })

    it('a removeDir of the root in another case is refused (it holds the state)', async () => {
      expect(await attempt(() => fs[M.fsRemoveDir]({ path: r.toUpperCase() }))).toBe('refused')
      expect(kept()).toBe(true)
    })

    // Round-7 N2: K2's worst vector — the agent config rename, onto the computer's own
    // config in another case: `rename(2)` replaces it (the hub then owns the computer).
    it('agentConfig.fs rename onto `.state/COMPUTER.CONFIG.JSON` is refused', async () => {
      writeFileSync(join(r, 'evil.json'), '{"hubUrl":"ws://evil"}')
      expect(
        await attempt(() =>
          agent[M.agentConfigFs]({
            op: 'rename',
            path: join(r, 'evil.json'),
            to: join(r, '.state', 'COMPUTER.CONFIG.JSON')
          })
        )
      ).toBe('refused')
      expect(kept()).toBe(true)
    })

    it('a not-yet-existing protected file is refused in any case', async () => {
      setProtectedPaths([join(r, '.state', 'credentials.json')])
      expect(
        await attempt(() =>
          fs[M.fsWriteFile]({ rootPath: r, filePath: '.state/CREDENTIALS.JSON', content: 'x' })
        )
      ).toBe('refused')
      expect(existsSync(join(r, '.state', 'credentials.json'))).toBe(false)
    })
  }
)

// Round-5 K8: the file editor's search read THROUGH links — to files outside the
// root, or to the computer's own credentials inside it (the protected filter checked
// the link's own path) — and readDir never judged its folder, so listing through a
// folder link showed what lies outside. Through the real handlers.
describe('K8: search and readDir never reach through a link out of the jail', () => {
  it('fs.searchFiles skips a link out and a link onto protected state', async () => {
    writeFileSync(join(o, 'secret.txt'), 'TOPSECRET line\n')
    mkdirSync(join(r, '.state'))
    writeFileSync(join(r, '.state', 'credentials.json'), 'TOKEN=abc\n')
    setProtectedPaths([join(r, '.state')])
    try {
      symlinkSync(join(o, 'secret.txt'), join(r, 'l'))
      symlinkSync(join(r, '.state', 'credentials.json'), join(r, 'c'))
      writeFileSync(join(r, 'ok.txt'), 'TOPSECRET in the root is fine\nTOKEN=here\n')
      const found = (await fs[M.fsSearchFiles]({ rootPath: r, query: 'TOPSECRET' })) as {
        results: Array<{ path: string }>
      }
      expect(found.results.map((x) => x.path)).toEqual(['ok.txt'])
      const tokens = (await fs[M.fsSearchFiles]({ rootPath: r, query: 'TOKEN=' })) as {
        results: Array<{ path: string }>
      }
      expect(tokens.results.map((x) => x.path)).toEqual(['ok.txt'])
    } finally {
      setProtectedPaths([])
    }
  })

  it('a link to a file inside the root is still searched', async () => {
    writeFileSync(join(r, 'real.txt'), 'NEEDLE\n')
    symlinkSync(join(r, 'real.txt'), join(r, 'alias.txt'))
    const found = (await fs[M.fsSearchFiles]({ rootPath: r, query: 'NEEDLE' })) as {
      results: Array<{ path: string }>
    }
    expect(found.results.map((x) => x.path).sort()).toEqual(['alias.txt', 'real.txt'])
  })

  it('fs.readDir through a folder link out is refused', async () => {
    writeFileSync(join(o, 'dir', 'outside-file'), 'x')
    symlinkSync(join(o, 'dir'), join(r, 'x'))
    expect(await attempt(() => fs[M.fsReadDir]({ rootPath: r, dirPath: 'x' }))).toBe('refused')
  })
})
