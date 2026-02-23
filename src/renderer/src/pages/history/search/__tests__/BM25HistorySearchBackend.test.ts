import { describe, expect, it } from 'vitest'

import { createBM25HistorySearchBackend } from '../backends/BM25HistorySearchBackend'
import { parseHistorySearchQuery } from '../queryParser'

describe('BM25HistorySearchBackend', () => {
  it('prioritizes exact phrase matches when query uses quotes', async () => {
    const backend = createBM25HistorySearchBackend()
    const query = '"quick brown fox"'
    const parsedQuery = parseHistorySearchQuery(query)

    const hits = await backend.search({
      query,
      parsedQuery,
      documents: [
        { id: 'doc-1', content: 'A quick brown fox appears once in this message.' },
        { id: 'doc-2', content: 'quick brown fox. Another quick brown fox appears here.' },
        { id: 'doc-3', content: 'quick fox and brown words are present but not contiguous.' }
      ]
    })

    expect(hits).toHaveLength(2)
    expect(hits[0].documentId).toBe('doc-2')
    expect(hits[1].documentId).toBe('doc-1')
    expect(hits.every((hit) => hit.matchedPhrases.includes('quick brown fox'))).toBe(true)
  })

  it('ranks documents by BM25 relevance for standard keyword queries', async () => {
    const backend = createBM25HistorySearchBackend()
    const query = 'timeout retry'
    const parsedQuery = parseHistorySearchQuery(query)

    const hits = await backend.search({
      query,
      parsedQuery,
      documents: [
        { id: 'doc-1', content: 'Retry after timeout. Timeout retry flow succeeded.' },
        { id: 'doc-2', content: 'Timeout happened and timeout happened again.' },
        { id: 'doc-3', content: 'Retry logic triggered once.' }
      ]
    })

    expect(hits[0].documentId).toBe('doc-1')
    expect(hits.map((hit) => hit.documentId)).toContain('doc-2')
    expect(hits.map((hit) => hit.documentId)).toContain('doc-3')
  })
})
