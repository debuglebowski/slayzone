// @vitest-environment jsdom
/**
 * The jsdom suites must run components the way the renderer ships them: compiled by
 * babel-plugin-react-compiler, through the same setup as the renderer build
 * (@slayzone/react-compiler-config, wired into packages/apps/app/vitest.config.ts).
 * Without it every suite tests uncompiled source, and a memoization bug in shipped
 * code (a stale cached value, an impure render-time read) cannot fail any of them.
 *
 * This pins that the config compiles: the compiler caches `formatLabel(name)` on
 * `name`, so re-rendering with only `count` changed must not call it again. The
 * uncompiled component calls it on every render.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const formatLabel = vi.fn((name: string) => name.toUpperCase())

function Counter({ name, count }: { name: string; count: number }) {
  const label = formatLabel(name)
  return (
    <span>
      {label}: {count}
    </span>
  )
}

describe('app vitest config', () => {
  it('compiles components with the React Compiler, like the renderer build', () => {
    const { rerender } = render(<Counter name="tasks" count={1} />)
    rerender(<Counter name="tasks" count={2} />)

    expect(screen.getByText('TASKS: 2')).toBeTruthy()
    expect(formatLabel).toHaveBeenCalledTimes(1)

    rerender(<Counter name="done" count={2} />)
    expect(screen.getByText('DONE: 2')).toBeTruthy()
    expect(formatLabel).toHaveBeenCalledTimes(2)
  })
})
