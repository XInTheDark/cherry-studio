export interface StreamingUpdateDelayConfig {
  /**
   * Base delay applied for short content (<= `thresholdChars`).
   */
  baseDelayMs: number
  /**
   * Content length threshold at which we start increasing the delay.
   */
  thresholdChars: number
  /**
   * Linear slope in ms per char above `thresholdChars`.
   */
  slopeMsPerChar: number
  /**
   * Maximum allowed delay.
   */
  maxDelayMs: number
}

export const DEFAULT_STREAMING_UPDATE_DELAY_CONFIG: StreamingUpdateDelayConfig = {
  baseDelayMs: 100,
  thresholdChars: 500,
  slopeMsPerChar: 0.05,
  maxDelayMs: 3000
}

/**
 * Compute an adaptive delay for streaming UI updates based on content length.
 *
 * This is designed so that short messages feel responsive, while long messages
 * back off (near-linear) to reduce heavy re-renders/markdown work.
 */
export const getStreamingUpdateDelayMs = (
  contentLength: number,
  config: StreamingUpdateDelayConfig = DEFAULT_STREAMING_UPDATE_DELAY_CONFIG
) => {
  const len = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0
  const base = Math.max(0, config.baseDelayMs)
  const threshold = Math.max(0, config.thresholdChars)
  const slope = Number.isFinite(config.slopeMsPerChar) ? Math.max(0, config.slopeMsPerChar) : 0
  const max = Number.isFinite(config.maxDelayMs) ? Math.max(0, config.maxDelayMs) : base

  if (len <= threshold) {
    return Math.min(base, max)
  }

  const delay = base + (len - threshold) * slope
  return Math.min(delay, max)
}
