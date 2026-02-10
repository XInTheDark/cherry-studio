import { describe, expect, it } from 'vitest'

import { estimateImageInputTokens, OPENAI_TYPICAL_IMAGE_INPUT_TOKENS } from '../tokenEstimation'

describe('tokenEstimation', () => {
  it('uses explicit file token metadata when available', () => {
    expect(estimateImageInputTokens({ tokens: 321.9 } as any)).toBe(321)
  })

  it('falls back to OpenAI typical image token baseline when metadata is missing', () => {
    expect(estimateImageInputTokens({} as any)).toBe(OPENAI_TYPICAL_IMAGE_INPUT_TOKENS)
  })

  it('falls back to baseline for non-positive token metadata', () => {
    expect(estimateImageInputTokens({ tokens: 0 } as any)).toBe(OPENAI_TYPICAL_IMAGE_INPUT_TOKENS)
    expect(estimateImageInputTokens({ tokens: -10 } as any)).toBe(OPENAI_TYPICAL_IMAGE_INPUT_TOKENS)
  })
})
