import { describe, expect, it } from 'vitest'

import {
  applyHistorySearchPostProcessing,
  deriveExactPhraseNeedle,
  type HistorySearchPostProcessableResult
} from '../resultPostProcessing'

const createResult = (
  overrides: Partial<HistorySearchPostProcessableResult> = {}
): HistorySearchPostProcessableResult => ({
  score: 1,
  createdAtMs: new Date('2026-02-23T00:00:00.000Z').getTime(),
  role: 'assistant',
  searchableContent: 'default content',
  ...overrides
})

describe('history search result post processing', () => {
  it('filters by role and date range', () => {
    const now = new Date('2026-02-23T12:00:00.000Z').getTime()
    const results = [
      createResult({
        role: 'assistant',
        createdAtMs: new Date('2026-02-23T10:00:00.000Z').getTime(),
        score: 4
      }),
      createResult({
        role: 'user',
        createdAtMs: new Date('2026-02-22T10:00:00.000Z').getTime(),
        score: 9
      }),
      createResult({
        role: 'assistant',
        createdAtMs: new Date('2026-01-01T10:00:00.000Z').getTime(),
        score: 10
      })
    ]

    const processed = applyHistorySearchPostProcessing(results, {
      sortBy: 'relevance',
      roleFilter: 'assistant',
      dateRange: '24h',
      exactPhraseOnly: false,
      exactPhraseNeedle: '',
      now
    })

    expect(processed).toHaveLength(1)
    expect(processed[0].role).toBe('assistant')
    expect(processed[0].createdAtMs).toBe(new Date('2026-02-23T10:00:00.000Z').getTime())
  })

  it('applies exact phrase filter and supports oldest sorting', () => {
    const results = [
      createResult({
        createdAtMs: new Date('2026-02-23T10:00:00.000Z').getTime(),
        searchableContent: 'the render failed due to error boundary failure',
        score: 8
      }),
      createResult({
        createdAtMs: new Date('2026-02-20T10:00:00.000Z').getTime(),
        searchableContent: 'error happened around boundary but phrase is split',
        score: 9
      }),
      createResult({
        createdAtMs: new Date('2026-02-22T10:00:00.000Z').getTime(),
        searchableContent: 'a repeated error boundary failure happened again',
        score: 7
      })
    ]

    const processed = applyHistorySearchPostProcessing(results, {
      sortBy: 'oldest',
      roleFilter: 'all',
      dateRange: 'all',
      exactPhraseOnly: true,
      exactPhraseNeedle: 'error boundary failure'
    })

    expect(processed).toHaveLength(2)
    expect(processed[0].createdAtMs).toBe(new Date('2026-02-22T10:00:00.000Z').getTime())
    expect(processed[1].createdAtMs).toBe(new Date('2026-02-23T10:00:00.000Z').getTime())
  })

  it('derives exact phrase needle from query data', () => {
    expect(deriveExactPhraseNeedle('"error boundary" failed', ['error boundary'], ['failed'])).toBe(
      'error boundary failed'
    )
    expect(deriveExactPhraseNeedle('"only phrase"', ['only phrase'], [])).toBe('only phrase')
  })
})
