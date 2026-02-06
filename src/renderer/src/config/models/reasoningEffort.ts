import type { Model, ReasoningEffortOption } from '@renderer/types'

import { isGPT5SeriesReasoningModel } from './openai'
import { getModelSupportedReasoningEffortOptions } from './reasoning'
import { isOpenAIWebSearchModel } from './websearch'

export type ReasoningEffortCoercionOptions = {
  /**
   * When true, apply additional safety/coercion rules for models with built-in web search.
   * (e.g. GPT-5 series cannot use `minimal` together with web search tooling.)
   */
  enableWebSearch?: boolean
}

function coerceToSupported(
  requested: Exclude<ReasoningEffortOption, 'default' | 'auto'>,
  supported: Exclude<ReasoningEffortOption, 'default'>[]
): Exclude<ReasoningEffortOption, 'default'> {
  const supportedSet = new Set(supported)
  if (supportedSet.has(requested)) return requested

  const pickFirstSupported = (...candidates: Exclude<ReasoningEffortOption, 'default'>[]) => {
    return candidates.find((c) => supportedSet.has(c)) ?? supported[0]
  }

  switch (requested) {
    case 'none':
      // "none" is the least reasoning; fallback to the next-lowest supported level.
      return pickFirstSupported('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'auto')
    case 'minimal':
      return pickFirstSupported('minimal', 'low', 'medium', 'high', 'xhigh', 'none', 'auto')
    case 'low':
      // Prefer a bit more reasoning over less when "low" isn't available.
      return pickFirstSupported('low', 'medium', 'high', 'minimal', 'xhigh', 'none', 'auto')
    case 'medium':
      return pickFirstSupported('medium', 'high', 'low', 'minimal', 'xhigh', 'none', 'auto')
    case 'high':
      // If "high" isn't available but "xhigh" is, prefer xhigh.
      return pickFirstSupported('high', 'xhigh', 'medium', 'low', 'minimal', 'none', 'auto')
    case 'xhigh':
      return pickFirstSupported('xhigh', 'high', 'medium', 'low', 'minimal', 'none', 'auto')
    default:
      return supported[0]
  }
}

/**
 * Coerce a requested reasoning effort to a value supported by the given model.
 *
 * This is intentionally conservative: it prefers to keep the user's intent while ensuring
 * we don't send unsupported effort values that could cause SDK/API errors.
 */
export function coerceReasoningEffortOptionForModel(
  requested: ReasoningEffortOption | undefined,
  model: Model,
  options?: ReasoningEffortCoercionOptions
): ReasoningEffortOption | undefined {
  if (requested === undefined) return undefined
  if (requested === 'default') return 'default'

  const supportedOptions = getModelSupportedReasoningEffortOptions(model)?.filter(
    (o): o is Exclude<ReasoningEffortOption, 'default'> => o !== 'default'
  )

  if (!supportedOptions || supportedOptions.length === 0) {
    // Model has no known support list; keep the original value.
    return requested
  }

  if (requested === 'auto') {
    // If model doesn't support auto, "medium" is the safest fallback.
    return supportedOptions.includes('auto')
      ? 'auto'
      : supportedOptions.includes('medium')
        ? 'medium'
        : supportedOptions[0]
  }

  // If already supported, keep it.
  if (supportedOptions.includes(requested)) {
    // Additional safety: GPT-5 series cannot combine `minimal` with built-in web search.
    if (
      options?.enableWebSearch &&
      requested === 'minimal' &&
      isOpenAIWebSearchModel(model) &&
      isGPT5SeriesReasoningModel(model)
    ) {
      return supportedOptions.includes('low') ? 'low' : supportedOptions[0]
    }
    return requested
  }

  const coerced = coerceToSupported(requested, supportedOptions)

  if (
    options?.enableWebSearch &&
    coerced === 'minimal' &&
    isOpenAIWebSearchModel(model) &&
    isGPT5SeriesReasoningModel(model)
  ) {
    return supportedOptions.includes('low') ? 'low' : supportedOptions[0]
  }

  return coerced
}
