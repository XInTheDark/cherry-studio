import { describe, expect, it } from 'vitest'

import { getHighlightTargets, parseHistorySearchQuery, tokenizeForSearch } from '../queryParser'

describe('history search query parser', () => {
  it('extracts quoted phrases and free-form terms', () => {
    const parsed = parseHistorySearchQuery('  "kernel panic" fix logs "disk full"  ')

    expect(parsed.phrases).toEqual(['kernel panic', 'disk full'])
    expect(parsed.terms).toEqual(['fix', 'logs'])
    expect(parsed.tokens).toEqual(['fix', 'logs', 'kernel', 'panic', 'disk', 'full'])
  })

  it('falls back to token parsing when quotes are unmatched', () => {
    const parsed = parseHistorySearchQuery('"open quote only')

    expect(parsed.phrases).toEqual([])
    expect(parsed.terms).toEqual(['open', 'quote', 'only'])
    expect(parsed.tokens).toEqual(['open', 'quote', 'only'])
  })

  it('returns highlight targets with phrases prioritized in deduped list', () => {
    const parsed = parseHistorySearchQuery('"quick brown fox" quick fox')

    expect(getHighlightTargets(parsed)).toEqual(['quick brown fox', 'quick', 'fox', 'brown'])
  })

  it('returns empty query metadata for blank input', () => {
    const parsed = parseHistorySearchQuery('   ')

    expect(parsed.isEmpty).toBe(true)
    expect(parsed.terms).toEqual([])
    expect(parsed.phrases).toEqual([])
    expect(parsed.tokens).toEqual([])
  })

  it('tokenizes unicode words consistently', () => {
    expect(tokenizeForSearch('Hello, 世界! 123')).toEqual(['hello', '世界', '123'])
  })
})
