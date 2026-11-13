import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMPUTER_LOG_DIR_NAME, COMPUTER_LOG_FILE_NAME, createComputerFileLog } from './file-log'

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
}

describe('computer file log', () => {
  it('appends each line, timestamped, under <stateDir>/logs', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'computer-log-'))
    const log = createComputerFileLog(stateDir)
    log('agent start admitted {"waitedMs":1200}')
    const file = join(stateDir, COMPUTER_LOG_DIR_NAME, COMPUTER_LOG_FILE_NAME)
    const read = () => {
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return ''
      }
    }
    await until(() => read().includes('admitted'))
    expect(read()).toMatch(/^\d{4}-\d\d-\d\dT[^ ]+ agent start admitted \{"waitedMs":1200\}\n$/)
  })

  it('an unusable state dir gives a no-op, never a throw', () => {
    const blocker = join(mkdtempSync(join(tmpdir(), 'computer-log-')), 'a-file')
    writeFileSync(blocker, '')
    const log = createComputerFileLog(blocker)
    expect(() => log('still running')).not.toThrow()
  })
})
