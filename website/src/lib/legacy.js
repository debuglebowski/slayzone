import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const legacyDir = path.join(rootDir, 'legacy')
const partialsDir = path.join(legacyDir, 'partials')
const pagesDir = path.join(legacyDir, 'pages')

function replacePartials(html) {
  let rendered = html
  for (let pass = 0; pass < 3; pass += 1) {
    for (const fileName of fs.readdirSync(partialsDir)) {
      if (!fileName.endsWith('.html')) continue
      const partialName = path.basename(fileName, '.html')
      const marker = `{{${partialName}}}`
      if (!rendered.includes(marker)) continue
      const replacement = fs.readFileSync(path.join(partialsDir, fileName), 'utf8').trimEnd()
      rendered = rendered.split(marker).join(replacement)
    }
  }
  return rendered
}

export function renderLegacyPage(fileName) {
  const source = fs.readFileSync(path.join(pagesDir, fileName), 'utf8')
  return replacePartials(source)
}

export function loadLegacySegments(fileName) {
  const html = renderLegacyPage(fileName)
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  const bodyContent = bodyMatch ? bodyMatch[1].trim() : html
  const styleMatches = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
  const styles = styleMatches.map((match) => match[1].trim()).join('\n\n')
  const scripts = []
  const bodyHtml = bodyContent.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (_match, code) => {
    scripts.push(code.trim())
    return ''
  })

  return {
    html,
    styles,
    bodyHtml: bodyHtml.trim(),
    scripts,
  }
}
