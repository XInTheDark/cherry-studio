import { describe, expect, it } from 'vitest'

import { computePromptWithDefaultAssistantPrefix } from '../AssistantPromptService'

describe('computePromptWithDefaultAssistantPrefix', () => {
  it('returns assistant prompt as-is when disabled', () => {
    expect(
      computePromptWithDefaultAssistantPrefix({
        enabled: false,
        defaultAssistantId: 'a-default',
        defaultAssistantPrompt: 'DEFAULT',
        assistantId: 'a-1',
        assistantPrompt: 'ASSISTANT'
      })
    ).toBe('ASSISTANT')
  })

  it('does not prefix when the assistant is the default assistant', () => {
    expect(
      computePromptWithDefaultAssistantPrefix({
        enabled: true,
        defaultAssistantId: 'a-default',
        defaultAssistantPrompt: 'DEFAULT',
        assistantId: 'a-default',
        assistantPrompt: 'ASSISTANT'
      })
    ).toBe('ASSISTANT')
  })

  it('does not prefix when default prompt is empty', () => {
    expect(
      computePromptWithDefaultAssistantPrefix({
        enabled: true,
        defaultAssistantId: 'a-default',
        defaultAssistantPrompt: '   ',
        assistantId: 'a-1',
        assistantPrompt: 'ASSISTANT'
      })
    ).toBe('ASSISTANT')
  })

  it('returns default prompt when assistant prompt is empty', () => {
    expect(
      computePromptWithDefaultAssistantPrefix({
        enabled: true,
        defaultAssistantId: 'a-default',
        defaultAssistantPrompt: 'DEFAULT',
        assistantId: 'a-1',
        assistantPrompt: ''
      })
    ).toBe('DEFAULT')
  })

  it('prefixes default prompt to assistant prompt with a blank line separator', () => {
    expect(
      computePromptWithDefaultAssistantPrefix({
        enabled: true,
        defaultAssistantId: 'a-default',
        defaultAssistantPrompt: 'DEFAULT',
        assistantId: 'a-1',
        assistantPrompt: 'ASSISTANT'
      })
    ).toBe('DEFAULT\n\nASSISTANT')
  })
})
