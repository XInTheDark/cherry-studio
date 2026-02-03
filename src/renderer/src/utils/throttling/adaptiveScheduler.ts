export interface AdaptiveScheduler<T> {
  (next: T): void
  flush: () => void
  cancel: () => void
}

export interface CreateAdaptiveSchedulerOptions<T> {
  /**
   * Compute the current delay in ms, based on the (coalesced) pending value.
   */
  getDelayMs: (pending: T) => number
  /**
   * Coalesce successive calls into a single pending value.
   * Default behavior overwrites with the latest value.
   */
  coalesce?: (prev: T | null, next: T) => T
  /**
   * If true (default), the first call flushes immediately (lodash.throttle-like).
   */
  leading?: boolean
  /**
   * Injectable clock/timer APIs for testing.
   */
  now?: () => number
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void
}

const normalizeDelayMs = (delayMs: number) => {
  if (!Number.isFinite(delayMs)) return 0
  return Math.max(0, delayMs)
}

/**
 * A tiny adaptive scheduler:
 * - supports dynamically changing delays based on the pending value
 * - coalesces multiple calls into one flush
 * - sequences async flushes so they don't run concurrently
 *
 * It behaves similarly to lodash.throttle with { leading: true, trailing: true },
 * but delay is evaluated dynamically per call.
 */
export const createAdaptiveScheduler = <T>(
  fn: (pending: T) => void | Promise<void>,
  options: CreateAdaptiveSchedulerOptions<T>
): AdaptiveScheduler<T> => {
  const coalesce = options.coalesce ?? ((_: T | null, next: T) => next)
  const leading = options.leading ?? true
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
  const clearTimer = options.clearTimer ?? ((id: ReturnType<typeof setTimeout>) => clearTimeout(id))

  let pending: T | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let nextFlushAt: number | null = null
  let lastFlushAt: number | null = null
  let cancelled = false

  // Ensure flushes don't overlap if fn is async.
  let inFlight = false
  let queuedAfterFlight: T | null = null

  const clearExistingTimer = () => {
    if (timer) {
      clearTimer(timer)
      timer = null
      nextFlushAt = null
    }
  }

  const schedule = () => {
    if (cancelled || pending === null) return

    const baseTime = lastFlushAt ?? now()
    const delayMs = normalizeDelayMs(options.getDelayMs(pending))
    const dueAt = baseTime + delayMs

    // If already scheduled for the same time, no-op.
    if (timer && nextFlushAt === dueAt) {
      return
    }

    // If scheduled for a different time, reschedule.
    clearExistingTimer()

    const wait = Math.max(0, dueAt - now())
    nextFlushAt = dueAt
    timer = setTimer(() => {
      timer = null
      nextFlushAt = null
      flush()
      // If more updates arrived while flushing, schedule again.
      if (pending !== null) {
        schedule()
      }
    }, wait)
  }

  const flush = () => {
    if (cancelled || pending === null) return

    const value = pending
    pending = null
    lastFlushAt = now()

    // If a previous flush is still running, keep only the latest coalesced value.
    if (inFlight) {
      queuedAfterFlight = queuedAfterFlight === null ? value : coalesce(queuedAfterFlight, value)
      return
    }

    const drainQueued = () => {
      if (cancelled || queuedAfterFlight === null) return
      const next = queuedAfterFlight
      queuedAfterFlight = null
      // Treat the queued run as a new flush moment for interval calculations.
      lastFlushAt = now()
      run(next)
    }

    const run = (valueToRun: T) => {
      inFlight = true
      let result: void | Promise<void>
      try {
        result = fn(valueToRun)
      } catch {
        // Intentionally swallow to keep scheduler resilient.
        inFlight = false
        drainQueued()
        return
      }

      Promise.resolve(result)
        .catch(() => {
          // Intentionally swallow.
        })
        .finally(() => {
          inFlight = false
          drainQueued()
        })
    }

    run(value)
  }

  const cancel = () => {
    cancelled = true
    pending = null
    clearExistingTimer()
  }

  const handler = ((next: T) => {
    if (cancelled) return

    pending = coalesce(pending, next)

    // lodash.throttle-like: first call is immediate (leading edge).
    if (leading && lastFlushAt === null) {
      clearExistingTimer()
      flush()
      return
    }

    schedule()
  }) as AdaptiveScheduler<T>

  handler.flush = () => {
    clearExistingTimer()
    flush()
  }

  handler.cancel = cancel

  return handler
}
