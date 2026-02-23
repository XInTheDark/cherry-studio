import { createBM25HistorySearchBackend } from './backends/BM25HistorySearchBackend'
import { parseHistorySearchQuery } from './queryParser'
import type { HistorySearchBackend, HistorySearchHit, HistorySearchRequest, HistorySearchResponse } from './types'

interface HistorySearchEngineOptions {
  backends: HistorySearchBackend[]
  defaultBackendId: string
}

const uniqueHits = (hits: HistorySearchHit[]): HistorySearchHit[] => {
  const dedupedByDocumentId = new Map<string, HistorySearchHit>()
  for (const hit of hits) {
    const existing = dedupedByDocumentId.get(hit.documentId)
    if (!existing || hit.score > existing.score) {
      dedupedByDocumentId.set(hit.documentId, hit)
    }
  }
  return Array.from(dedupedByDocumentId.values()).sort((a, b) => b.score - a.score)
}

export class HistorySearchEngine {
  private readonly backends = new Map<string, HistorySearchBackend>()
  private defaultBackendId: string

  constructor(options: HistorySearchEngineOptions) {
    for (const backend of options.backends) {
      this.backends.set(backend.id, backend)
    }
    if (!this.backends.has(options.defaultBackendId)) {
      throw new Error(`Default search backend "${options.defaultBackendId}" is not registered.`)
    }
    this.defaultBackendId = options.defaultBackendId
  }

  public registerBackend(backend: HistorySearchBackend): void {
    this.backends.set(backend.id, backend)
  }

  public setDefaultBackend(backendId: string): void {
    if (!this.backends.has(backendId)) {
      throw new Error(`Search backend "${backendId}" is not registered.`)
    }
    this.defaultBackendId = backendId
  }

  public listBackendIds(): string[] {
    return Array.from(this.backends.keys())
  }

  public async search(request: HistorySearchRequest): Promise<HistorySearchResponse> {
    const parsedQuery = parseHistorySearchQuery(request.query)
    if (parsedQuery.isEmpty || request.documents.length === 0) {
      return {
        backendId: this.resolveBackendId(request.backendId),
        parsedQuery,
        hits: []
      }
    }

    const backendId = this.resolveBackendId(request.backendId)
    const backend = this.backends.get(backendId)
    if (!backend) {
      throw new Error(`Search backend "${backendId}" is not registered.`)
    }

    const backendHits = await backend.search({
      query: request.query,
      parsedQuery,
      documents: request.documents,
      limit: request.limit
    })

    const uniqueSortedHits = uniqueHits(backendHits)

    return {
      backendId,
      parsedQuery,
      hits: request.limit ? uniqueSortedHits.slice(0, request.limit) : uniqueSortedHits
    }
  }

  private resolveBackendId(requestedBackendId?: string): string {
    if (requestedBackendId && this.backends.has(requestedBackendId)) {
      return requestedBackendId
    }
    return this.defaultBackendId
  }
}

const bm25Backend = createBM25HistorySearchBackend()

export const historySearchEngine = new HistorySearchEngine({
  backends: [bm25Backend],
  defaultBackendId: bm25Backend.id
})
