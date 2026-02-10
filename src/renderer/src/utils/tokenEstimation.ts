import type { FileMetadata } from '@renderer/types'

/**
 * OpenAI vision pricing docs use 1024x1024 with high detail as a common reference,
 * which maps to 765 input tokens.
 */
export const OPENAI_TYPICAL_IMAGE_INPUT_TOKENS = 765

export function estimateImageInputTokens(file: Pick<FileMetadata, 'tokens'>): number {
  const tokenEstimate = file.tokens

  if (typeof tokenEstimate === 'number' && Number.isFinite(tokenEstimate) && tokenEstimate > 0) {
    return Math.floor(tokenEstimate)
  }

  return OPENAI_TYPICAL_IMAGE_INPUT_TOKENS
}
