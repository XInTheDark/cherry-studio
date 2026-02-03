import { describe, expect, it } from 'vitest'

import { getStreamingUpdateDelayMs } from '../throttling/streamingUpdateDelay'

describe('getStreamingUpdateDelayMs', () => {
  it('uses base delay for short content', () => {
    expect(getStreamingUpdateDelayMs(0)).toBe(100)
    expect(getStreamingUpdateDelayMs(-1)).toBe(100)
    expect(getStreamingUpdateDelayMs(1)).toBe(100)
    expect(getStreamingUpdateDelayMs(500)).toBe(100)
  })

  it('scales near-linearly after the threshold', () => {
    // delay = 100 + (len - 500) * 0.05
    expect(getStreamingUpdateDelayMs(520)).toBeCloseTo(101, 5)
    expect(getStreamingUpdateDelayMs(1500)).toBeCloseTo(150, 5)
    expect(getStreamingUpdateDelayMs(5000)).toBeCloseTo(325, 5)
  })

  it('caps at max delay', () => {
    // Huge value should cap at 3000ms
    expect(getStreamingUpdateDelayMs(1_000_000)).toBe(3000)
  })
})
