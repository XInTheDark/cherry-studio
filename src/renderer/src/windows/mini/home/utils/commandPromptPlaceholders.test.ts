import { describe, expect, it, vi } from 'vitest'

import { resolveCommandPromptPlaceholders } from './commandPromptPlaceholders'

describe('resolveCommandPromptPlaceholders', () => {
  it('replaces {selected}', async () => {
    const output = await resolveCommandPromptPlaceholders('Explain: {selected}', {
      selected: async () => 'selected text',
      clipboard: async () => 'clipboard text'
    })

    expect(output).toBe('Explain: selected text')
  })

  it('replaces {clipboard}', async () => {
    const output = await resolveCommandPromptPlaceholders('Summarize: {clipboard}', {
      selected: async () => 'selected text',
      clipboard: async () => 'clipboard text'
    })

    expect(output).toBe('Summarize: clipboard text')
  })

  it('supports fallback with {selected|clipboard}', async () => {
    const output = await resolveCommandPromptPlaceholders('Input: {selected|clipboard}', {
      selected: async () => '',
      clipboard: async () => 'clipboard text'
    })

    expect(output).toBe('Input: clipboard text')
  })

  it('leaves unknown placeholders unchanged', async () => {
    const output = await resolveCommandPromptPlaceholders('Keep {unknown}', {
      selected: async () => 'selected text',
      clipboard: async () => 'clipboard text'
    })

    expect(output).toBe('Keep {unknown}')
  })

  it('resolves each token at most once', async () => {
    const selected = vi.fn(async () => 'selected text')
    const clipboard = vi.fn(async () => 'clipboard text')

    const output = await resolveCommandPromptPlaceholders('{selected} + {selected|clipboard} + {clipboard}', {
      selected,
      clipboard
    })

    expect(output).toBe('selected text + selected text + clipboard text')
    expect(selected).toHaveBeenCalledTimes(1)
    expect(clipboard).toHaveBeenCalledTimes(1)
  })
})
