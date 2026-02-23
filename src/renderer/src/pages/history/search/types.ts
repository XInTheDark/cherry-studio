export interface HistorySearchDocument {
  id: string
  content: string
  createdAt?: string
  updatedAt?: string
}

export interface ParsedHistorySearchQuery {
  raw: string
  normalized: string
  terms: string[]
  phrases: string[]
  tokens: string[]
  isEmpty: boolean
}

export interface HistorySearchHit {
  documentId: string
  score: number
  matchedTerms: string[]
  matchedPhrases: string[]
}

export interface HistorySearchBackendRequest {
  query: string
  parsedQuery: ParsedHistorySearchQuery
  documents: HistorySearchDocument[]
  limit?: number
}

export interface HistorySearchBackend {
  id: string
  search: (request: HistorySearchBackendRequest) => Promise<HistorySearchHit[]> | HistorySearchHit[]
}

export interface HistorySearchRequest {
  query: string
  documents: HistorySearchDocument[]
  backendId?: string
  limit?: number
}

export interface HistorySearchResponse {
  backendId: string
  parsedQuery: ParsedHistorySearchQuery
  hits: HistorySearchHit[]
}
