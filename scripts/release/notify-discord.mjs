#!/usr/bin/env node
// Sends a Discord webhook message for a release, based on changelog-data.json.
// Usage: node scripts/release/notify-discord.mjs --version <version> --webhook-url <url> [--release-url <url>]

import fs from 'node:fs'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    'webhook-url': { type: 'string' },
    'release-url': { type: 'string' },
  },
})

const version = (values.version || '').replace(/^v/, '')
const webhookUrl = values['webhook-url']
const releaseUrl = values['release-url']

if (!version || !webhookUrl) {
  console.error('Usage: notify-discord.mjs --version <version> --webhook-url <url>')
  process.exit(1)
}

const changelog = JSON.parse(
  fs.readFileSync(
    'packages/apps/app/src/renderer/src/components/changelog/changelog-data.json',
    'utf8'
  )
)

const entry = changelog.find((e) => e.version === version)

// Fallback if version not in changelog
if (!entry) {
  const payload = {
    embeds: [
      {
        title: `SlayZone v${version} released`,
        url: releaseUrl || undefined,
        color: 0x7c3aed,
      },
    ],
  }
  await send(payload)
  process.exit(0)
}

const icons = { feature: '🚀', improvement: '✨', fix: '🐛' }

const description = entry.items
  .map((i) => `${icons[i.category] || '•'}  **${i.title}** — ${i.description}`)
  .join('\n')

const payload = {
  embeds: [
    {
      title: `SlayZone v${version} — ${entry.tagline}`,
      url: releaseUrl || undefined,
      description,
      color: 0x7c3aed,
      footer: { text: entry.date },
    },
  ],
}

await send(payload)

async function send(payload) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    console.error(`Discord webhook failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }

  console.log('Discord notification sent')
}
