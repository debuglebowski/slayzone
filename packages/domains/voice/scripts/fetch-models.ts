/**
 * Dev stand-in for the future downloadable voice module: fetch the pinned local
 * voice models into the models directory.
 *
 *   pnpm --filter @slayzone/voice models            # default models → client root
 *   pnpm --filter @slayzone/voice models --all      # + optional (Kokoro; the bench needs it)
 *   pnpm --filter @slayzone/voice models --dir <d>  # somewhere else
 *
 * Default dir: `~/.slayzone/<dev|stable>/client/voice-models` (SLAYZONE_RELEASE_CHANNEL
 * picks the bucket, as for the app). Needs `curl` and `tar` (bzip2).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { getClientRoot } from '@slayzone/platform'
import { ALL_VOICE_MODELS, DEFAULT_VOICE_MODELS, VOICE_MODELS_DIRNAME } from '../src/shared/models'

const args = process.argv.slice(2)
const dirArg = args.indexOf('--dir')
const dir = dirArg >= 0 ? args[dirArg + 1] : join(getClientRoot(), VOICE_MODELS_DIRNAME)
const specs = args.includes('--all') ? ALL_VOICE_MODELS : DEFAULT_VOICE_MODELS

mkdirSync(dir, { recursive: true })
console.log(`voice models → ${dir}`)
for (const spec of specs) {
  for (const file of spec.files) {
    const target = join(dir, file.installed)
    if (existsSync(target)) {
      console.log(`  ✓ ${file.installed}`)
      continue
    }
    console.log(`  ↓ ${spec.label}: ${basename(file.url)} (~${file.approxMb} MB)`)
    const tmp = mkdtempSync(join(tmpdir(), 'slz-voice-'))
    const download = join(tmp, basename(file.url))
    execFileSync('curl', ['-fL', '--progress-bar', '-o', download, file.url], { stdio: 'inherit' })
    if (download.endsWith('.tar.bz2')) {
      execFileSync('tar', ['xjf', download, '-C', tmp], { stdio: 'inherit' })
      renameSync(join(tmp, file.installed), target)
    } else {
      renameSync(download, target)
    }
    rmSync(tmp, { recursive: true, force: true })
  }
}
console.log('done')
