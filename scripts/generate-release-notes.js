#!/usr/bin/env node
// Generates GitHub release notes from changelog-data.json.
// Usage: node scripts/generate-release-notes.js <version>
// Outputs markdown to stdout. Exit 0 with no output if version not found.

const fs = require('fs')

const version = (process.argv[2] || '').replace(/^v/, '')
if (!version) {
  console.error('Usage: generate-release-notes.js <version>')
  process.exit(1)
}

const changelog = JSON.parse(
  fs.readFileSync(
    'packages/apps/app/src/renderer/src/components/changelog/changelog-data.json',
    'utf8'
  )
)

const entry = changelog.find((e) => e.version === version)
if (!entry) process.exit(0)

const icons = { feature: '🚀', improvement: '✨', fix: '🐛' }
let body = `## ${entry.tagline}\n\n`
body += entry.items
  .map((i) => `${icons[i.category] || '•'}  **${i.title}** — ${i.description}`)
  .join('\n')

process.stdout.write(body)
