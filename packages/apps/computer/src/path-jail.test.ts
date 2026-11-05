/**
 * The computer's one path jail: a table of every escape found so far, the swap
 * races, and a generated fuzz — random path forms over random link layouts — that
 * asserts a write never lands outside the root.
 */
import {
  existsSync,
  lstatSync,
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { judgePath, judgePathIn, jailedFs, setProtectedPaths, type JailAccess } from './path-jail'

let base: string
let r: string
let o: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'path-jail-')))
  r = join(base, 'r')
  o = join(base, 'o')
  mkdirSync(r)
  mkdirSync(join(o, 'dir'), { recursive: true })
})
afterEach(() => {
  setProtectedPaths([])
  rmSync(base, { recursive: true, force: true })
})

const judge = (p: string, access: JailAccess = 'write') => judgePath(p, [r], { access })

describe('the table: every escape, judged', () => {
  type Row = {
    name: string
    layout?: () => void
    path: () => string
    access?: JailAccess
    /** null = refused; else where the op would run. */
    expect: () => string | null
    posixOnly?: boolean
  }
  const rows: Row[] = [
    { name: '..', path: () => `${r}/../o/f`, expect: () => null },
    { name: 'absolute outside', path: () => join(o, 'f'), expect: () => null },
    { name: 'prefix sibling', path: () => `${r}-evil/f`, expect: () => null },
    { name: 'NUL', path: () => `${r}/a\0b`, expect: () => null },
    {
      name: 'backslash is a name (POSIX)',
      path: () => `${r}/..\\o\\f`,
      expect: () => `${r}/..\\o\\f`,
      posixOnly: true
    },
    {
      name: 'POSIX: x\\..\\r after a .. (round-3 follow-up)',
      path: () => `${r}/../x\\..\\r/f`,
      expect: () => null,
      posixOnly: true
    },
    {
      name: 'UNC is a name (POSIX)',
      path: () => `${r}/\\\\srv\\share\\x`,
      expect: () => `${r}/\\\\srv\\share\\x`,
      posixOnly: true
    },
    {
      name: 'link to a folder out',
      layout: () => symlinkSync(join(o, 'dir'), join(r, 'x')),
      path: () => `${r}/x/f`,
      expect: () => null
    },
    {
      name: 'dangling link out (R9)',
      layout: () => symlinkSync(join(o, 'new'), join(r, 'd')),
      path: () => `${r}/d`,
      expect: () => null
    },
    {
      name: 'dangling link inside: refused for a write',
      layout: () => symlinkSync(join(r, 'later'), join(r, 'd')),
      path: () => `${r}/d`,
      expect: () => null
    },
    {
      name: 'dangling link inside: judged by its target for a read',
      layout: () => symlinkSync(join(r, 'later'), join(r, 'd')),
      path: () => `${r}/d`,
      access: 'read',
      expect: () => join(r, 'later')
    },
    {
      name: 'link reached through a link (F3 #1)',
      layout: () => {
        symlinkSync(join(o, 'dir'), join(r, 'x'))
        symlinkSync('../secret', join(o, 'dir', 'f'))
      },
      path: () => `${r}/x/f`,
      expect: () => null
    },
    {
      name: '`..` after a link (F3 #2): normalized first, the op runs inside',
      layout: () => symlinkSync(join(o, 'dir'), join(r, 's')),
      path: () => `${r}/s/../y`,
      expect: () => join(r, 'y')
    },
    {
      name: 'link target with `..` through a link out (F3 #2)',
      layout: () => {
        symlinkSync(join(o, 'dir'), join(r, 's'))
        symlinkSync('s/../y', join(r, 'x2'))
      },
      path: () => `${r}/x2`,
      expect: () => null
    },
    {
      name: 'root/miss/../l with l dangling out (G1)',
      layout: () => symlinkSync(join(o, 'secret.txt'), join(r, 'l')),
      path: () => `${r}/miss/../l`,
      expect: () => null
    },
    {
      name: 'an in-root link to an existing file is followed',
      layout: () => {
        writeFileSync(join(r, 'AGENTS.md'), 'x')
        symlinkSync('AGENTS.md', join(r, 'CLAUDE.md'))
      },
      path: () => `${r}/CLAUDE.md`,
      expect: () => join(r, 'AGENTS.md')
    },
    {
      name: 'entry: a link out is the entry itself (delete it, not its target)',
      layout: () => symlinkSync(join(o, 'dir'), join(r, 'x')),
      path: () => `${r}/x`,
      access: 'entry',
      expect: () => join(r, 'x')
    },
    {
      name: 'entry: through a link out is still refused',
      layout: () => symlinkSync(join(o, 'dir'), join(r, 'x')),
      path: () => `${r}/x/f`,
      access: 'entry',
      expect: () => null
    },
    {
      name: 'link loop',
      layout: () => {
        symlinkSync(join(r, 'b'), join(r, 'a'))
        symlinkSync(join(r, 'a'), join(r, 'b'))
      },
      path: () => `${r}/a/f`,
      expect: () => null
    }
  ]

  for (const row of rows) {
    it.skipIf(row.posixOnly && process.platform === 'win32')(row.name, () => {
      row.layout?.()
      const want = row.expect()
      if (want === null) {
        expect(() => judge(row.path(), row.access)).toThrow()
      } else {
        expect(judge(row.path(), row.access)).toBe(want)
      }
    })
  }

  it('a root spelled through a link above it (/tmp → /private/tmp)', () => {
    symlinkSync(r, join(base, 'alias'))
    expect(judgePath(join(base, 'alias', 'f'), [r], { access: 'write' })).toBe(join(r, 'f'))
    expect(judgePath(join(r, 'f'), [join(base, 'alias')], { access: 'write' })).toBe(join(r, 'f'))
  })

  it('a protected path, and its ancestor for a subtree op', () => {
    mkdirSync(join(r, 'state'))
    setProtectedPaths([join(r, 'state', 'computer.config.json')])
    expect(() => judge(`${r}/state/computer.config.json`)).toThrow(/own state/)
    expect(() => judgePath(`${r}/state`, [r], { subtree: true })).toThrow(/own state/)
    expect(judgePath(`${r}/state`, [r])).toBe(join(r, 'state'))
  })

  it('no roots configured: everything refused', () => {
    expect(() => judgePath(r, [])).toThrow(/no allowedRoots/)
  })

  it('judgePathIn keeps the relative part inside its root', () => {
    mkdirSync(join(r, 'ws'))
    expect(() => judgePathIn(join(r, 'ws'), '../outside-ws', [r])).toThrow(/traversal/)
    expect(judgePathIn(join(r, 'ws'), 'a/b', [r]).path).toBe(join(r, 'ws', 'a', 'b'))
  })
})

describe('jailedFs: re-checked right before the write', () => {
  it('a folder swapped for a link after the judgement is refused', () => {
    const target = judge(`${r}/later/f.txt`)
    symlinkSync(join(o, 'dir'), join(r, 'later'))
    expect(() => jailedFs.writeFile(target, 'x')).toThrow()
    expect(existsSync(join(o, 'dir', 'f.txt'))).toBe(false)
  })

  it('a link put at the file itself after the judgement is not written through', () => {
    const target = judge(`${r}/g.txt`)
    symlinkSync(join(o, 'g.txt'), join(r, 'g.txt'))
    expect(() => jailedFs.writeFile(target, 'x')).toThrow()
    expect(() => jailedFs.createFile(target)).toThrow()
    expect(existsSync(join(o, 'g.txt'))).toBe(false)
  })

  it('a folder in a deep mkdir swapped mid-way creates nothing outside', () => {
    const target = judge(`${r}/a/b/c/f`)
    mkdirSync(join(r, 'a'))
    symlinkSync(join(o, 'dir'), join(r, 'a', 'b'))
    expect(() => jailedFs.writeFile(target, 'x')).toThrow()
    expect(readdirSync(join(o, 'dir'))).toEqual([])
  })

  it('createFile refuses an existing name, a dangling link included', () => {
    writeFileSync(join(r, 'a'), '1')
    symlinkSync(join(o, 'new'), join(r, 'd'))
    expect(() => jailedFs.createFile(join(r, 'a'))).toThrow(/already exists/)
    expect(() => jailedFs.createFile(join(r, 'd'))).toThrow(/already exists/)
    expect(existsSync(join(o, 'new'))).toBe(false)
  })

  it('copy copies a tree, links as links, and never into a link', () => {
    mkdirSync(join(r, 'src', 'sub'), { recursive: true })
    writeFileSync(join(r, 'src', 'sub', 'f'), 'hi')
    symlinkSync('sub/f', join(r, 'src', 'ln'))
    jailedFs.copy(judge(`${r}/src`, 'read'), judge(`${r}/dst`))
    expect(readFileSync(join(r, 'dst', 'sub', 'f'), 'utf-8')).toBe('hi')
    expect(lstatSync(join(r, 'dst', 'ln')).isSymbolicLink()).toBe(true)
    expect(() => jailedFs.copy(join(r, 'src'), join(r, 'src', 'sub', 'x'))).toThrow(/into itself/)
  })

  it('plain writes still work: new file, deep mkdir -p, overwrite', () => {
    jailedFs.writeFile(judge(`${r}/deep/er/f`), 'one')
    jailedFs.writeFile(judge(`${r}/deep/er/f`), 'two')
    expect(readFileSync(join(r, 'deep', 'er', 'f'), 'utf-8')).toBe('two')
  })
})

/**
 * Generated: random layouts of links (in-root, out, dangling either way, relative
 * with `..`, chains) and random path forms over them. Whatever the jail answers, a
 * write through it must never create or change anything outside `r`.
 */
describe('fuzz: a write never lands outside the root', () => {
  let seed = 0x5eed
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % n
  }
  const pick = <T>(xs: readonly T[]): T => xs[rand(xs.length)]!

  const snapshot = (dir: string): string => {
    const out: string[] = []
    const walk = (d: string, rel: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        out.push(
          `${rel}${e.name}:${e.isFile() ? readFileSync(p, 'utf-8') : e.isDirectory() ? '/' : 'l'}`
        )
        if (e.isDirectory()) walk(p, `${rel}${e.name}/`)
      }
    }
    walk(dir, '')
    return out.sort().join('\n')
  }

  it('2,000 trials', () => {
    const names = ['a', 'b', 'l1', 'l2', 'l3', 'miss', 'f']
    for (let trial = 0; trial < 2000; trial++) {
      rmSync(r, { recursive: true, force: true })
      rmSync(o, { recursive: true, force: true })
      mkdirSync(join(r, 'a', 'b'), { recursive: true })
      mkdirSync(join(o, 'dir'), { recursive: true })
      writeFileSync(join(r, 'a', 'f'), 'in')
      writeFileSync(join(o, 'dir', 'f'), 'out')
      const targets = [
        () => join(o, 'dir'),
        () => join(o, 'dir', 'f'),
        () => join(o, 'missing'),
        () => '../o/dir',
        () => '../../o/dir/f',
        () => 'a',
        () => 'a/b',
        () => 'missing-in',
        () => 'a/../../o',
        () => 'l2',
        () => 'l3/..',
        () => join(r, 'a')
      ]
      for (const name of ['l1', 'l2', 'l3']) {
        const where = pick([r, join(r, 'a'), join(o, 'dir')])
        try {
          symlinkSync(pick(targets)(), join(where, name))
        } catch {
          /* taken */
        }
      }
      const parts: string[] = []
      for (let i = 0, n = 1 + rand(5); i < n; i++) parts.push(pick([...names, '..', '.', '']))
      const form = pick(['abs', 'rel', 'alias'])
      const rel = parts.join('/')
      const before = snapshot(o)
      try {
        if (form === 'rel') {
          jailedFs.writeFile(judgePathIn(r, rel, [r], { access: 'write' }).path, 'w')
        } else {
          const prefix = form === 'alias' ? `${r}/a/..` : r
          jailedFs.writeFile(judgePath(`${prefix}/${rel}`, [r], { access: 'write' }), 'w')
        }
      } catch {
        /* refused is fine */
      }
      expect(snapshot(o), `trial ${trial}: ${form} ${rel}`).toBe(before)
    }
  }, 120_000)
})
