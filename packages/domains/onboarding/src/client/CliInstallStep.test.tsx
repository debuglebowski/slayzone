// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createTrpcTest } from '@slayzone/transport/testing'
import { CliInstallStep } from './CliInstallStep'

afterEach(() => {
  cleanup()
})

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  })
}

function setup(installedAnswers: boolean[], installResult: Record<string, unknown>) {
  let checks = 0
  const trpc = createTrpcTest({
    procedures: {
      'app.meta.checkCliInstalled': () => ({
        installed: installedAnswers[Math.min(checks++, installedAnswers.length - 1)]
      }),
      'app.meta.installCli': () => installResult
    }
  })
  const Wrapper = trpc.wrapper
  const view = render(
    <Wrapper>
      <CliInstallStep onNext={vi.fn()} />
    </Wrapper>
  )
  return { view, queryClient: trpc.queryClient }
}

describe('CliInstallStep', () => {
  it('renders nothing until the status resolves, then the install prompt', async () => {
    const { view } = setup([false], { ok: true })
    expect(view.container.innerHTML).toBe('<div></div>')
    expect(screen.queryByText('Install the slay CLI')).toBeNull()
    await flush()
    expect(screen.getByText('Install the slay CLI')).toBeTruthy()
  })

  it('already installed → success view', async () => {
    setup([true], { ok: true })
    await flush()
    expect(screen.getByText('CLI installed.')).toBeTruthy()
  })

  it('install success flips to installed; a later refetch result is mirrored again', async () => {
    const { queryClient } = setup([false, false], { ok: true, pathNotInPATH: false })
    await flush()
    await act(async () => {
      fireEvent.click(screen.getByText('Install'))
    })
    await flush()
    expect(screen.getByText('CLI installed.')).toBeTruthy()

    // Refetch returns the same shape/value → structurally shared, no change.
    await act(async () => {
      await queryClient.invalidateQueries()
    })
    await flush()
    expect(screen.getByText('CLI installed.')).toBeTruthy()
  })

  it('install failure keeps the prompt and shows the message', async () => {
    setup([false], { ok: false, error: 'nope' })
    await flush()
    await act(async () => {
      fireEvent.click(screen.getByText('Install'))
    })
    await flush()
    expect(screen.getByText('nope')).toBeTruthy()
    expect(screen.getByText('Install the slay CLI')).toBeTruthy()
  })
})
