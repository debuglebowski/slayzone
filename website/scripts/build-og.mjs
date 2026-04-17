import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const repoRoot = resolve(root, '..')

const src = resolve(repoRoot, 'comparison/assets/slayzone-homepage-hero.png')
const out = resolve(root, 'public/assets/og-preview.jpg')

if (!existsSync(src)) {
  console.error(`[build-og] source missing: ${src}`)
  process.exit(1)
}

await sharp(src)
  .resize(1200, 630, { fit: 'cover', position: 'top' })
  .jpeg({ quality: 88, progressive: true, mozjpeg: true })
  .toFile(out)

console.log(`wrote ${out}`)
