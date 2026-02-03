import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAdaptiveScheduler } from '../throttling/adaptiveScheduler'

describe('createAdaptiveScheduler', () => {
  const baseTime = new Date('2024-01-01T00:00:00Z')

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(baseTime)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('flushes immediately on the first call by default (leading)', async () => {
    const fn = vi.fn()
    const scheduler = createAdaptiveScheduler(fn, { getDelayMs: () => 100 })

    scheduler('a')
    // flush runs through a promise chain (microtask)
    await Promise.resolve()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('a')
  })

  it('coalesces calls and flushes later based on the last flush time', async () => {
    const fn = vi.fn()
    const scheduler = createAdaptiveScheduler(fn, { getDelayMs: () => 100 })

    scheduler('a') // t=0, immediate
    await Promise.resolve()
    expect(fn).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(10)
    scheduler('b') // pending, scheduled for t=100
    scheduler('c') // overwrite pending

    vi.advanceTimersByTime(89) // t=99
    expect(fn).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1) // t=100
    await Promise.resolve()
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenLastCalledWith('c')
  })

  it('reschedules when delay increases (adaptive)', async () => {
    const fn = vi.fn()
    const scheduler = createAdaptiveScheduler(fn, {
      getDelayMs: (pending: { len: number }) => 100 + Math.max(0, pending.len - 500) * 0.05
    })

    scheduler({ len: 10 }) // t=0 immediate
    await Promise.resolve()
    expect(fn).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(10) // t=10
    scheduler({ len: 600 }) // delay ~105 => due at 105 (since last flush at 0)

    vi.advanceTimersByTime(10) // t=20
    scheduler({ len: 5000 }) // delay ~325 => should push due to 325

    vi.advanceTimersByTime(104) // t=124 (< 325)
    expect(fn).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(201) // t=325
    await Promise.resolve()
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenLastCalledWith({ len: 5000 })
  })

  it('supports custom coalescing (merge objects)', async () => {
    const fn = vi.fn()
    const scheduler = createAdaptiveScheduler(fn, {
      getDelayMs: () => 100,
      coalesce: (prev: any | null, next: any) => ({ ...prev, ...next })
    })

    scheduler({ a: 1 }) // immediate
    await Promise.resolve()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenLastCalledWith({ a: 1 })

    vi.advanceTimersByTime(10)
    scheduler({ b: 2 })
    scheduler({ c: 3 })

    vi.advanceTimersByTime(90) // t=100
    await Promise.resolve()
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenLastCalledWith({ b: 2, c: 3 })
  })
})
