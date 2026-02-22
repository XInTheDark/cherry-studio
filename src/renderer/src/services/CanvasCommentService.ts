import { loggerService } from '@logger'
import type {
  CanvasCommentAnchor,
  CanvasCommentAuthor,
  CanvasCommentEntry,
  CanvasCommentReply,
  CanvasCommentsIndexV1,
  CanvasCommentType
} from '@renderer/types'
import { uuid } from '@renderer/utils'

import { joinFsPath, normalizeFsPath } from './canvasHistory/pathUtils'
import { EVENT_NAMES, EventEmitter } from './EventService'

const logger = loggerService.withContext('CanvasCommentService')

const DEFAULT_PREFIX_LEN = 48
const DEFAULT_SUFFIX_LEN = 48

type ResolvedCanvasCommentAnchor = {
  comment: CanvasCommentEntry
  start: number
  end: number
}

let appDataPathPromise: Promise<string> | null = null
const lockChains = new Map<string, Promise<unknown>>()

function nowIso(): string {
  return new Date().toISOString()
}

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = lockChains.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  lockChains.set(key, next)
  try {
    return await next
  } finally {
    if (lockChains.get(key) === next) {
      lockChains.delete(key)
    }
  }
}

async function getAppDataPath(): Promise<string> {
  if (!appDataPathPromise) {
    appDataPathPromise = window.api.getAppInfo().then((info) => {
      const p = info?.appDataPath
      if (!p) {
        throw new Error('Missing appDataPath from App_Info')
      }
      return p as string
    })
  }
  return appDataPathPromise
}

function getCanvasCommentsDir(appDataPath: string, canvasId: string): string {
  return joinFsPath(normalizeFsPath(appDataPath), 'Data', 'Canvases', canvasId)
}

function getCommentsIndexPath(appDataPath: string, canvasId: string): string {
  return joinFsPath(getCanvasCommentsDir(appDataPath, canvasId), 'comments.json')
}

function normalizeCommentType(value: string | undefined): CanvasCommentType {
  if (value === 'important' || value === 'suggestion' || value === 'question' || value === 'none') {
    return value
  }
  return 'none'
}

function sanitizeCommentEntry(canvasId: string, raw: any): CanvasCommentEntry | null {
  if (!raw || typeof raw !== 'object') return null
  if (!raw.id || !raw.anchor || !raw.content) return null

  const replies: CanvasCommentReply[] = Array.isArray(raw.replies)
    ? raw.replies
        .filter((reply) => reply && reply.id && reply.content)
        .map((reply) => ({
          id: String(reply.id),
          content: String(reply.content),
          author: reply.author === 'assistant' || reply.author === 'system' ? reply.author : 'human',
          createdAt: String(reply.createdAt || nowIso()),
          updatedAt: String(reply.updatedAt || reply.createdAt || nowIso())
        }))
    : []

  return {
    id: String(raw.id),
    canvasId,
    type: normalizeCommentType(raw.type),
    content: String(raw.content),
    status: raw.status === 'resolved' ? 'resolved' : 'open',
    anchor: {
      exact: String(raw.anchor.exact || ''),
      prefix: raw.anchor.prefix ? String(raw.anchor.prefix) : undefined,
      suffix: raw.anchor.suffix ? String(raw.anchor.suffix) : undefined,
      startOffset: typeof raw.anchor.startOffset === 'number' ? raw.anchor.startOffset : undefined,
      endOffset: typeof raw.anchor.endOffset === 'number' ? raw.anchor.endOffset : undefined
    },
    anchorPreview: String(raw.anchorPreview || raw.anchor?.exact || ''),
    createdBy: raw.createdBy === 'assistant' || raw.createdBy === 'system' ? raw.createdBy : 'human',
    createdAt: String(raw.createdAt || nowIso()),
    updatedAt: String(raw.updatedAt || raw.createdAt || nowIso()),
    resolvedAt: raw.resolvedAt ? String(raw.resolvedAt) : undefined,
    resolvedBy: raw.resolvedBy === 'assistant' || raw.resolvedBy === 'system' ? raw.resolvedBy : undefined,
    replies
  }
}

async function safeReadJson<T>(path: string): Promise<T | null> {
  try {
    const text = await window.api.fs.readText(path)
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

async function ensureDir(path: string): Promise<void> {
  try {
    await window.api.file.mkdir(path)
  } catch (error) {
    logger.debug('Failed to mkdir (ignored):', { path, error: (error as Error)?.message })
  }
}

async function loadOrCreateCommentsIndex(appDataPath: string, canvasId: string): Promise<CanvasCommentsIndexV1> {
  const path = getCommentsIndexPath(appDataPath, canvasId)
  const existing = await safeReadJson<CanvasCommentsIndexV1>(path)
  if (existing?.version === 1 && Array.isArray(existing.comments)) {
    return {
      version: 1,
      updatedAt: existing.updatedAt || nowIso(),
      comments: existing.comments
        .map((entry) => sanitizeCommentEntry(canvasId, entry))
        .filter((entry): entry is CanvasCommentEntry => Boolean(entry))
    }
  }
  return { version: 1, updatedAt: nowIso(), comments: [] }
}

async function saveCommentsIndex(appDataPath: string, canvasId: string, index: CanvasCommentsIndexV1): Promise<void> {
  index.updatedAt = nowIso()
  await ensureDir(getCanvasCommentsDir(appDataPath, canvasId))
  await window.api.file.write(getCommentsIndexPath(appDataPath, canvasId), JSON.stringify(index, null, 2))
}

function matchSuffixScore(candidate: string, expected: string): number {
  const max = Math.min(candidate.length, expected.length)
  let score = 0
  for (let i = 1; i <= max; i += 1) {
    if (candidate.at(-i) !== expected.at(-i)) break
    score += 1
  }
  return score
}

function matchPrefixScore(candidate: string, expected: string): number {
  const max = Math.min(candidate.length, expected.length)
  let score = 0
  for (let i = 0; i < max; i += 1) {
    if (candidate[i] !== expected[i]) break
    score += 1
  }
  return score
}

function findBestAnchorOffsets(content: string, anchor: CanvasCommentAnchor): { start: number; end: number } | null {
  const exact = anchor.exact
  if (!exact || exact.length === 0) return null

  const hits: number[] = []
  let idx = content.indexOf(exact)
  while (idx !== -1) {
    hits.push(idx)
    idx = content.indexOf(exact, idx + 1)
  }

  if (hits.length === 0) {
    if (
      typeof anchor.startOffset === 'number' &&
      typeof anchor.endOffset === 'number' &&
      anchor.startOffset >= 0 &&
      anchor.endOffset > anchor.startOffset &&
      anchor.endOffset <= content.length
    ) {
      return { start: anchor.startOffset, end: anchor.endOffset }
    }
    return null
  }

  const expectedPrefix = anchor.prefix ?? ''
  const expectedSuffix = anchor.suffix ?? ''
  const prefixLen = expectedPrefix.length
  const suffixLen = expectedSuffix.length

  let best: { start: number; end: number; score: number } | null = null
  for (const start of hits) {
    const end = start + exact.length
    const prefixCandidate = content.slice(Math.max(0, start - prefixLen), start)
    const suffixCandidate = content.slice(end, Math.min(content.length, end + suffixLen))
    const score = matchSuffixScore(prefixCandidate, expectedPrefix) + matchPrefixScore(suffixCandidate, expectedSuffix)
    if (!best || score > best.score) {
      best = { start, end, score }
    }
  }

  return best ? { start: best.start, end: best.end } : null
}

function findUniquePatternOffsets(content: string, pattern: string): { start: number; end: number } {
  if (!pattern) {
    throw new Error('pattern must be non-empty')
  }

  const hits: number[] = []
  let idx = content.indexOf(pattern)
  while (idx !== -1) {
    hits.push(idx)
    idx = content.indexOf(pattern, idx + pattern.length)
  }

  if (hits.length === 0) {
    throw new Error('pattern not found in canvas')
  }
  if (hits.length > 1) {
    throw new Error(`pattern matched ${hits.length} times; provide a more specific snippet`)
  }

  return { start: hits[0], end: hits[0] + pattern.length }
}

function normalizeOffsets(content: string, start: number, end: number): { start: number; end: number } | null {
  const max = content.length
  const nextStart = Math.max(0, Math.min(max, Math.floor(start)))
  const nextEnd = Math.max(0, Math.min(max, Math.floor(end)))
  if (nextEnd <= nextStart) return null
  return { start: nextStart, end: nextEnd }
}

function buildAnchorFromOffsetsInternal(content: string, start: number, end: number): CanvasCommentAnchor {
  const exact = content.slice(start, end)
  const prefix = content.slice(Math.max(0, start - DEFAULT_PREFIX_LEN), start)
  const suffix = content.slice(end, Math.min(content.length, end + DEFAULT_SUFFIX_LEN))
  return {
    exact,
    prefix,
    suffix,
    startOffset: start,
    endOffset: end
  }
}

function emitCommentsUpdated(payload: {
  canvasId: string
  commentId: string
  action: 'add' | 'reply' | 'resolve' | 'reopen'
}) {
  void EventEmitter.emit(EVENT_NAMES.CANVAS_COMMENTS_UPDATED, payload).catch((error) => {
    logger.debug('Failed to emit canvas comments update event (ignored):', {
      error: (error as Error)?.message,
      canvasId: payload.canvasId,
      commentId: payload.commentId
    })
  })
}

export const CanvasCommentService = {
  buildAnchorFromOffsets: (content: string, start: number, end: number): CanvasCommentAnchor | null => {
    const normalized = normalizeOffsets(content, start, end)
    if (!normalized) return null
    return buildAnchorFromOffsetsInternal(content, normalized.start, normalized.end)
  },

  resolveAnchorOffsets: (content: string, anchor: CanvasCommentAnchor): { start: number; end: number } | null => {
    return findBestAnchorOffsets(content, anchor)
  },

  listComments: async (canvasId: string): Promise<CanvasCommentsIndexV1> => {
    if (!canvasId) return { version: 1, updatedAt: nowIso(), comments: [] }
    const appDataPath = await getAppDataPath()
    const lockKey = `canvas-comments:${normalizeFsPath(appDataPath)}:${canvasId}`
    return withLock(lockKey, async () => {
      const index = await loadOrCreateCommentsIndex(appDataPath, canvasId)
      return {
        ...index,
        comments: [...index.comments].sort((a, b) =>
          a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
        )
      }
    })
  },

  addComment: async ({
    canvasId,
    comment,
    type,
    anchor,
    createdBy
  }: {
    canvasId: string
    comment: string
    type?: CanvasCommentType
    anchor: CanvasCommentAnchor
    createdBy: CanvasCommentAuthor
  }): Promise<CanvasCommentEntry> => {
    const content = comment.trim()
    if (!content) {
      throw new Error('comment must be non-empty')
    }
    if (!anchor?.exact?.trim()) {
      throw new Error('comment anchor must have exact text')
    }

    const appDataPath = await getAppDataPath()
    const lockKey = `canvas-comments:${normalizeFsPath(appDataPath)}:${canvasId}`
    return withLock(lockKey, async () => {
      const index = await loadOrCreateCommentsIndex(appDataPath, canvasId)
      const entry: CanvasCommentEntry = {
        id: uuid(),
        canvasId,
        type: type || 'none',
        content,
        status: 'open',
        anchor,
        anchorPreview: anchor.exact.slice(0, 160),
        createdBy,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        replies: []
      }
      index.comments.push(entry)
      await saveCommentsIndex(appDataPath, canvasId, index)
      emitCommentsUpdated({ canvasId, commentId: entry.id, action: 'add' })
      return entry
    })
  },

  addCommentByPattern: async ({
    notesPath,
    canvasId,
    pattern,
    comment,
    type,
    createdBy
  }: {
    notesPath: string
    canvasId: string
    pattern: string
    comment: string
    type?: CanvasCommentType
    createdBy: CanvasCommentAuthor
  }): Promise<CanvasCommentEntry> => {
    const { default: CanvasHistoryService } = await import('./CanvasHistoryService')
    const resolved = await CanvasHistoryService.resolveFilePathForCanvasId({ notesPath, canvasId })
    if (!resolved?.filePath) {
      throw new Error(`Unknown canvasId (not found in mapping): ${canvasId}`)
    }

    const markdown = await window.api.fs.readText(resolved.filePath)
    const { start, end } = findUniquePatternOffsets(markdown, pattern)
    const anchor = buildAnchorFromOffsetsInternal(markdown, start, end)

    return CanvasCommentService.addComment({
      canvasId,
      comment,
      type,
      anchor,
      createdBy
    })
  },

  addCommentByOffsets: async ({
    canvasId,
    markdownContent,
    startOffset,
    endOffset,
    comment,
    type,
    createdBy
  }: {
    canvasId: string
    markdownContent: string
    startOffset: number
    endOffset: number
    comment: string
    type?: CanvasCommentType
    createdBy: CanvasCommentAuthor
  }): Promise<CanvasCommentEntry> => {
    const normalized = normalizeOffsets(markdownContent, startOffset, endOffset)
    if (!normalized) {
      throw new Error('Invalid selection range')
    }
    const anchor = buildAnchorFromOffsetsInternal(markdownContent, normalized.start, normalized.end)
    return CanvasCommentService.addComment({
      canvasId,
      comment,
      type,
      anchor,
      createdBy
    })
  },

  replyToComment: async ({
    canvasId,
    commentId,
    content,
    author
  }: {
    canvasId: string
    commentId: string
    content: string
    author: CanvasCommentAuthor
  }): Promise<CanvasCommentEntry> => {
    const trimmed = content.trim()
    if (!trimmed) {
      throw new Error('reply content must be non-empty')
    }

    const appDataPath = await getAppDataPath()
    const lockKey = `canvas-comments:${normalizeFsPath(appDataPath)}:${canvasId}`
    return withLock(lockKey, async () => {
      const index = await loadOrCreateCommentsIndex(appDataPath, canvasId)
      const target = index.comments.find((item) => item.id === commentId)
      if (!target) {
        throw new Error(`Comment not found: ${commentId}`)
      }

      const now = nowIso()
      target.replies.push({
        id: uuid(),
        content: trimmed,
        author,
        createdAt: now,
        updatedAt: now
      })
      target.updatedAt = now

      await saveCommentsIndex(appDataPath, canvasId, index)
      emitCommentsUpdated({ canvasId, commentId: target.id, action: 'reply' })
      return target
    })
  },

  setCommentResolved: async ({
    canvasId,
    commentId,
    resolved,
    actor
  }: {
    canvasId: string
    commentId: string
    resolved: boolean
    actor: CanvasCommentAuthor
  }): Promise<CanvasCommentEntry> => {
    const appDataPath = await getAppDataPath()
    const lockKey = `canvas-comments:${normalizeFsPath(appDataPath)}:${canvasId}`
    return withLock(lockKey, async () => {
      const index = await loadOrCreateCommentsIndex(appDataPath, canvasId)
      const target = index.comments.find((item) => item.id === commentId)
      if (!target) {
        throw new Error(`Comment not found: ${commentId}`)
      }

      const now = nowIso()
      target.status = resolved ? 'resolved' : 'open'
      target.updatedAt = now
      if (resolved) {
        target.resolvedAt = now
        target.resolvedBy = actor
      } else {
        delete target.resolvedAt
        delete target.resolvedBy
      }

      await saveCommentsIndex(appDataPath, canvasId, index)
      emitCommentsUpdated({ canvasId, commentId: target.id, action: resolved ? 'resolve' : 'reopen' })
      return target
    })
  },

  resolveUnresolvedAnchors: async ({
    canvasId,
    markdownContent
  }: {
    canvasId: string
    markdownContent: string
  }): Promise<ResolvedCanvasCommentAnchor[]> => {
    const index = await CanvasCommentService.listComments(canvasId)
    const unresolved = index.comments.filter((item) => item.status !== 'resolved')
    const resolved: ResolvedCanvasCommentAnchor[] = []

    for (const comment of unresolved) {
      const offsets = findBestAnchorOffsets(markdownContent, comment.anchor)
      if (!offsets) continue
      resolved.push({
        comment,
        start: offsets.start,
        end: offsets.end
      })
    }

    return resolved
  }
}

export default CanvasCommentService
