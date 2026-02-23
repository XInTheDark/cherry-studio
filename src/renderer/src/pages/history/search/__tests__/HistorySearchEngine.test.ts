import { describe, expect, it } from 'vitest'

import { createBM25HistorySearchBackend } from '../backends/BM25HistorySearchBackend'
import { HistorySearchEngine } from '../HistorySearchEngine'
import type { HistorySearchBackend } from '../types'

describe('HistorySearchEngine', () => {
  it('supports registering and invoking custom backends', async () => {
    const bm25 = createBM25HistorySearchBackend()
    const semanticMock: HistorySearchBackend = {
      id: 'semantic-mock',
      search: ({ parsedQuery }) => [
        {
          documentId: 'semantic-doc',
          score: 42,
          matchedTerms: parsedQuery.tokens,
          matchedPhrases: parsedQuery.phrases
        }
      ]
    }

    const engine = new HistorySearchEngine({
      backends: [bm25],
      defaultBackendId: bm25.id
    })
    engine.registerBackend(semanticMock)

    const result = await engine.search({
      query: '"error boundary" failed',
      backendId: 'semantic-mock',
      documents: [{ id: 'doc-1', content: 'error boundary failed in render step' }]
    })

    expect(result.backendId).toBe('semantic-mock')
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].documentId).toBe('semantic-doc')
    expect(result.parsedQuery.phrases).toEqual(['error boundary'])
  })

  it('falls back to default backend when requested backend is missing', async () => {
    const bm25 = createBM25HistorySearchBackend()
    const engine = new HistorySearchEngine({
      backends: [bm25],
      defaultBackendId: bm25.id
    })

    const result = await engine.search({
      query: 'timeout',
      backendId: 'missing-backend',
      documents: [
        { id: 'doc-1', content: 'timeout happened once' },
        { id: 'doc-2', content: 'all good' }
      ]
    })

    expect(result.backendId).toBe('bm25')
    expect(result.hits[0].documentId).toBe('doc-1')
  })
})
