import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { featurePath, features } from '../src/data/features.js'
import { renderLegacyPage } from '../src/lib/legacy.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const legacyDir = path.join(rootDir, 'legacy')
const publicDir = path.join(rootDir, '.astro-public')
const assetsDir = path.join(rootDir, 'assets')

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

async function writeFile(filePath, content) {
  await ensureDir(path.dirname(filePath))
  await fs.writeFile(filePath, content)
}

function buildSitemapXml() {
  const entries = [
    { loc: 'https://slay.zone/', changefreq: 'weekly', priority: '1.0' },
    { loc: 'https://slay.zone/features.html', changefreq: 'weekly', priority: '0.9' },
    { loc: 'https://slay.zone/docs.html', changefreq: 'weekly', priority: '0.8' },
    { loc: 'https://slay.zone/faq.html', changefreq: 'monthly', priority: '0.6' },
    { loc: 'https://slay.zone/comparison.html', changefreq: 'monthly', priority: '0.7' },
    ...features.map((feature) => ({
      loc: `https://slay.zone${featurePath(feature)}`,
      changefreq: 'monthly',
      priority: '0.7',
    })),
  ]

  const body = entries
    .map(
      (entry) => `  <url>
    <loc>${entry.loc}</loc>
    <changefreq>${entry.changefreq}</changefreq>
    <priority>${entry.priority}</priority>
  </url>`,
    )
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`
}

await fs.rm(publicDir, { recursive: true, force: true })
await ensureDir(publicDir)
await fs.cp(assetsDir, publicDir, { recursive: true })

const legacyPages = ['index.html', 'docs.html', 'faq.html', 'comparison.html', '404.html']
for (const page of legacyPages) {
  const rendered = renderLegacyPage(page)
  await writeFile(path.join(publicDir, page), rendered)
}

await fs.copyFile(path.join(legacyDir, 'robots.txt'), path.join(publicDir, 'robots.txt'))
await fs.copyFile(path.join(legacyDir, '_redirects'), path.join(publicDir, '_redirects'))
await writeFile(path.join(publicDir, 'sitemap.xml'), buildSitemapXml())
