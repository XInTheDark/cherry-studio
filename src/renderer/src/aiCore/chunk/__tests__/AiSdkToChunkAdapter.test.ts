import { ChunkType } from '@renderer/types/chunk'
import { describe, expect, it, vi } from 'vitest'

import { AiSdkToChunkAdapter } from '../AiSdkToChunkAdapter'

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      silly: vi.fn(),
      warn: vi.fn()
    })
  }
}))

describe('AiSdkToChunkAdapter', () => {
  it('merges consecutive reasoning blocks into a single thinking block', async () => {
    const emittedChunks: any[] = []
    const adapter = new AiSdkToChunkAdapter((chunk) => emittedChunks.push(chunk), [], false, false)

    const parts: any[] = [
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', text: 'First' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'reasoning-start', id: 'r2' },
      { type: 'reasoning-delta', id: 'r2', text: 'Second' },
      { type: 'reasoning-end', id: 'r2' },
      { type: 'text-start' },
      { type: 'text-delta', text: 'Hello' },
      { type: 'text-end', providerMetadata: { text: { value: 'Hello' } } },
      { type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    ]

    const fullStream = new ReadableStream({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(part)
        }
        controller.close()
      }
    })

    await adapter.processStream({ fullStream, text: Promise.resolve('') })

    const thinkingStarts = emittedChunks.filter((c) => c.type === ChunkType.THINKING_START)
    const thinkingCompletes = emittedChunks.filter((c) => c.type === ChunkType.THINKING_COMPLETE)

    expect(thinkingStarts).toHaveLength(1)
    expect(thinkingCompletes).toHaveLength(1)
    expect(thinkingCompletes[0].text).toBe('First\n\nSecond')

    const thinkingCompleteIndex = emittedChunks.findIndex((c) => c.type === ChunkType.THINKING_COMPLETE)
    const textStartIndex = emittedChunks.findIndex((c) => c.type === ChunkType.TEXT_START)
    expect(thinkingCompleteIndex).toBeGreaterThan(-1)
    expect(textStartIndex).toBeGreaterThan(-1)
    expect(thinkingCompleteIndex).toBeLessThan(textStartIndex)
  })
})
