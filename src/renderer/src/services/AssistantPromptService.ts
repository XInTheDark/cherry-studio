import store from '@renderer/store'
import type { Assistant } from '@renderer/types'

type DefaultAssistantPromptConfig = {
  enabled: boolean
  defaultAssistantId: string
  defaultAssistantPrompt?: string
  assistantId: string
  assistantPrompt?: string
}

/**
 * Computes the effective system prompt when "Always use Default Assistant prompt" is enabled.
 *
 * Rules:
 * - If disabled: return assistantPrompt as-is
 * - If the current assistant is the default assistant: return assistantPrompt as-is
 * - If the default assistant has no prompt: return assistantPrompt as-is
 * - Otherwise: return `${defaultPrompt}\n\n${assistantPrompt}` (or just defaultPrompt if assistantPrompt is empty)
 */
export function computePromptWithDefaultAssistantPrefix(config: DefaultAssistantPromptConfig): string {
  const basePrompt = config.assistantPrompt ?? ''

  if (!config.enabled) return basePrompt
  if (!config.defaultAssistantId) return basePrompt
  if (config.assistantId === config.defaultAssistantId) return basePrompt

  const defaultPrompt = (config.defaultAssistantPrompt ?? '').trim()
  if (!defaultPrompt) return basePrompt

  const trimmedBase = basePrompt.trim()
  if (!trimmedBase) return defaultPrompt

  return `${defaultPrompt}\n\n${basePrompt}`
}

export function applyDefaultAssistantPromptPrefix<T extends Assistant>(assistant: T): T {
  const state = store.getState()

  const defaultAssistantId = state.settings.defaultAssistantId ?? state.assistants.defaultAssistant.id
  const enabled = !!state.settings.alwaysUseDefaultAssistantPrompt

  // Prefer the assistant list (since the selected default assistant can be any assistant),
  // then fall back to the legacy default assistant.
  const defaultAssistant =
    state.assistants.assistants.find((a) => a.id === defaultAssistantId) ?? state.assistants.defaultAssistant

  const prompt = computePromptWithDefaultAssistantPrefix({
    enabled,
    defaultAssistantId,
    defaultAssistantPrompt: defaultAssistant?.prompt,
    assistantId: assistant.id,
    assistantPrompt: assistant.prompt
  })

  // Preserve object identity when nothing changes (helps avoid unnecessary renders).
  if ((assistant.prompt ?? '') === prompt) return assistant
  return { ...assistant, prompt } as T
}
