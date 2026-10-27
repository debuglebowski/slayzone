/**
 * Pure parser tests for bg-shell-helpers.
 * Run: pnpm dlx tsx packages/domains/terminal/src/shared/bg-shell-helpers.test.ts
 */
import { expect, test } from 'vitest'
import type { ToolCallEvent, ToolResultEvent } from './agent-events'
import {
  extractBgShellSpawn,
  extractShellIdFromSpawnResult,
  extractBashOutputCall,
  extractKillShellCall,
  extractBashOutputResult
} from './bg-shell-helpers'

const call = (id: string, name: string, input: unknown): ToolCallEvent => ({
  kind: 'tool-call',
  id,
  name,
  input
})

const result = (
  toolUseId: string,
  rawContent: unknown,
  structured: unknown = null,
  isError = false
): ToolResultEvent => ({
  kind: 'tool-result',
  toolUseId,
  isError,
  rawContent,
  structured
})

test('extractBgShellSpawn — flagged Bash → spawn signal', () => {
  const sig = extractBgShellSpawn(
    call('t1', 'Bash', {
      command: 'pnpm dev',
      run_in_background: true,
      description: 'dev server'
    })
  )
  expect(sig?.toolUseId).toBe('t1')
  expect(sig?.command).toBe('pnpm dev')
  expect(sig?.description).toBe('dev server')
})

test('extractBgShellSpawn — Bash without flag → null', () => {
  const sig = extractBgShellSpawn(call('t1', 'Bash', { command: 'ls', run_in_background: false }))
  expect(sig).toBeNull()
})

test('extractBgShellSpawn — non-Bash → null', () => {
  const sig = extractBgShellSpawn(
    call('t1', 'Read', { file_path: '/tmp/x', run_in_background: true })
  )
  expect(sig).toBeNull()
})

test('extractShellIdFromSpawnResult — structured.shellId', () => {
  const id = extractShellIdFromSpawnResult(result('t1', '', { shellId: 'bash_3' }))
  expect(id).toBe('bash_3')
})

test('extractShellIdFromSpawnResult — text "shell ID: bash_2"', () => {
  const id = extractShellIdFromSpawnResult(
    result('t1', 'Command running in background with shell ID: bash_2')
  )
  expect(id).toBe('bash_2')
})

test('extractShellIdFromSpawnResult — content blocks array', () => {
  const id = extractShellIdFromSpawnResult(
    result('t1', [{ type: 'text', text: 'started bash_5 ok' }])
  )
  expect(id).toBe('bash_5')
})

test('extractShellIdFromSpawnResult — no signal → null', () => {
  expect(extractShellIdFromSpawnResult(result('t1', 'no id here'))).toBeNull()
})

test('extractBashOutputCall — bash_id input', () => {
  const sig = extractBashOutputCall(call('t9', 'BashOutput', { bash_id: 'bash_1' }))
  expect(sig?.shellId).toBe('bash_1')
  expect(sig?.toolUseId).toBe('t9')
})

test('extractBashOutputCall — non-BashOutput → null', () => {
  expect(extractBashOutputCall(call('t1', 'Bash', {}))).toBeNull()
})

test('extractKillShellCall — shell_id input', () => {
  const sig = extractKillShellCall(call('t2', 'KillShell', { shell_id: 'bash_4' }))
  expect(sig?.shellId).toBe('bash_4')
})

test('extractBashOutputResult — structured running', () => {
  const sig = extractBashOutputResult(
    result('t1', '', {
      status: 'running',
      stdout: 'tick\n',
      stderr: ''
    })
  )
  expect(sig.status).toBe('running')
  expect(sig.stdout).toBe('tick\n')
  expect(sig.exitCode).toBeNull()
})

test('extractBashOutputResult — structured completed w/ exit code', () => {
  const sig = extractBashOutputResult(
    result('t1', '', { status: 'completed', exitCode: 0, stdout: 'done\n' })
  )
  expect(sig.status).toBe('completed')
  expect(sig.exitCode).toBe(0)
})

test('extractBashOutputResult — text fallback "Status: completed / Exit code: 1"', () => {
  const sig = extractBashOutputResult(
    result('t1', 'Status: completed\nExit code: 1\n<stdout>\noops\n</stdout>')
  )
  expect(sig.status).toBe('completed')
  expect(sig.exitCode).toBe(1)
})

test('extractBashOutputResult — is_error infers failed', () => {
  const sig = extractBashOutputResult(result('t1', 'broken', null, true))
  expect(sig.status).toBe('failed')
})
