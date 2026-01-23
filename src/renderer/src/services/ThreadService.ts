import { loggerService } from '@logger'
import type { ThreadAnchor, ThreadTopicRef } from '@renderer/types/thread'

const logger = loggerService.withContext('ThreadService')

const THREAD_TOPIC_PREFIX = 'thread__'

export const isThreadTopicId = (topicId: string): boolean => topicId.startsWith(THREAD_TOPIC_PREFIX)

export const buildThreadTopicId = (ref: ThreadTopicRef): string => {
  // Using a delimiter that won't appear in UUIDs.
  return `${THREAD_TOPIC_PREFIX}${ref.parentTopicId}__${ref.parentMessageId}__${ref.threadId}`
}

export const parseThreadTopicId = (topicId: string): ThreadTopicRef | null => {
  if (!isThreadTopicId(topicId)) return null
  const raw = topicId.slice(THREAD_TOPIC_PREFIX.length)
  const parts = raw.split('__')
  if (parts.length < 3) return null

  // parentTopicId can itself contain the delimiter if it is also a thread topicId.
  // So we parse from the end.
  const threadId = parts.at(-1)
  const parentMessageId = parts.at(-2)
  const parentTopicId = parts.slice(0, -2).join('__')

  if (!threadId || !parentMessageId || !parentTopicId) return null
  return { parentTopicId, parentMessageId, threadId }
}

export const getRangeTextOffsetsWithin = (
  container: HTMLElement,
  range: Range
): { startOffset: number; endOffset: number } | null => {
  try {
    const startRange = document.createRange()
    startRange.selectNodeContents(container)
    startRange.setEnd(range.startContainer, range.startOffset)
    const startOffset = startRange.toString().length

    const endRange = document.createRange()
    endRange.selectNodeContents(container)
    endRange.setEnd(range.endContainer, range.endOffset)
    const endOffset = endRange.toString().length

    return { startOffset, endOffset }
  } catch (error) {
    logger.warn('Failed to compute selection offsets:', error as Error)
    return null
  }
}

export const buildThreadAnchorFromSelection = (
  container: HTMLElement,
  range: Range,
  options?: { prefixLen?: number; suffixLen?: number }
): ThreadAnchor | null => {
  const selectedText = range.toString()
  if (!selectedText || selectedText.trim().length === 0) return null

  const offsets = getRangeTextOffsetsWithin(container, range)
  if (!offsets) return null

  const text = container.textContent ?? ''
  const prefixLen = options?.prefixLen ?? 32
  const suffixLen = options?.suffixLen ?? 32

  const startOffset = offsets.startOffset
  const endOffset = offsets.endOffset

  if (startOffset < 0 || endOffset < 0 || endOffset <= startOffset) return null
  if (endOffset > text.length) {
    // Shouldn't happen, but keep it safe.
    logger.warn('Selection offsets exceed container text length', { startOffset, endOffset, textLen: text.length })
  }

  const prefix = text.slice(Math.max(0, startOffset - prefixLen), startOffset)
  const suffix = text.slice(endOffset, Math.min(text.length, endOffset + suffixLen))

  return {
    // blockId is filled by caller (depends on DOM lookup).
    blockId: '',
    exact: selectedText,
    prefix,
    suffix,
    startOffset,
    endOffset
  }
}

const matchSuffixScore = (candidate: string, expected: string): number => {
  const max = Math.min(candidate.length, expected.length)
  let score = 0
  for (let i = 1; i <= max; i += 1) {
    if (candidate.at(-i) !== expected.at(-i)) break
    score += 1
  }
  return score
}

const matchPrefixScore = (candidate: string, expected: string): number => {
  const max = Math.min(candidate.length, expected.length)
  let score = 0
  for (let i = 0; i < max; i += 1) {
    if (candidate[i] !== expected[i]) break
    score += 1
  }
  return score
}

export const findBestAnchorOffsets = (text: string, anchor: ThreadAnchor): { start: number; end: number } | null => {
  const exact = anchor.exact
  if (!exact || exact.length === 0) return null

  const hits: number[] = []
  let idx = text.indexOf(exact)
  while (idx !== -1) {
    hits.push(idx)
    idx = text.indexOf(exact, idx + 1)
  }

  if (hits.length === 0) {
    // Fallback to offsets if present.
    if (
      typeof anchor.startOffset === 'number' &&
      typeof anchor.endOffset === 'number' &&
      anchor.startOffset >= 0 &&
      anchor.endOffset > anchor.startOffset &&
      anchor.endOffset <= text.length
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
    const prefixCandidate = text.slice(Math.max(0, start - prefixLen), start)
    const suffixCandidate = text.slice(end, Math.min(text.length, end + suffixLen))
    const score = matchSuffixScore(prefixCandidate, expectedPrefix) + matchPrefixScore(suffixCandidate, expectedSuffix)
    if (!best || score > best.score) {
      best = { start, end, score }
    }
  }

  return best ? { start: best.start, end: best.end } : null
}

export const rangeFromOffsets = (container: HTMLElement, start: number, end: number): Range | null => {
  if (start < 0 || end <= start) return null

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let currentOffset = 0
  let startNode: Text | null = null
  let startNodeOffset = 0
  let endNode: Text | null = null
  let endNodeOffset = 0

  let node = walker.nextNode() as Text | null
  while (node) {
    const len = node.nodeValue?.length ?? 0
    const nextOffset = currentOffset + len

    if (!startNode && start >= currentOffset && start <= nextOffset) {
      startNode = node
      startNodeOffset = start - currentOffset
    }

    if (!endNode && end >= currentOffset && end <= nextOffset) {
      endNode = node
      endNodeOffset = end - currentOffset
      break
    }

    currentOffset = nextOffset
    node = walker.nextNode() as Text | null
  }

  if (!startNode || !endNode) return null

  try {
    const range = document.createRange()
    range.setStart(startNode, Math.max(0, startNodeOffset))
    range.setEnd(endNode, Math.max(0, endNodeOffset))
    return range
  } catch (error) {
    logger.warn('Failed to create DOM range from offsets:', error as Error)
    return null
  }
}

type ThreadHighlightMeta = {
  threadTopicId: string
  parentMessageId: string
  starterPrompt: string
}

const applyHighlightDataset = (span: HTMLSpanElement, meta: ThreadHighlightMeta) => {
  span.className = 'thread-highlight'
  span.dataset.threadHighlight = '1'
  span.dataset.threadTopicId = meta.threadTopicId
  span.dataset.threadParentMessageId = meta.parentMessageId
  span.dataset.threadStarterPrompt = meta.starterPrompt
}

const wrapTextNodePortion = (node: Text, startOffset: number, endOffset: number, meta: ThreadHighlightMeta) => {
  const text = node.nodeValue ?? ''
  const len = text.length
  const start = Math.max(0, Math.min(len, startOffset))
  const end = Math.max(0, Math.min(len, endOffset))
  if (end <= start) return

  // Split into [before][selected][after] and wrap the selected portion only.
  // Order matters: split at start first, then split the selected tail.
  const selected = node.splitText(start)
  selected.splitText(end - start)

  const span = document.createElement('span')
  applyHighlightDataset(span, meta)

  const parent = selected.parentNode
  if (!parent) return
  parent.insertBefore(span, selected)
  span.appendChild(selected)
}

/**
 * Wrap a text range with highlight spans without extracting/moving block elements.
 *
 * Important: using Range.extractContents() can accidentally move <li>/<p> nodes when the
 * selection crosses boundaries, causing list rendering to break (e.g. empty bullets).
 * This helper only wraps Text nodes in-place (by splitting them), which is much safer.
 */
export const wrapThreadHighlightSafely = (
  container: HTMLElement,
  offsets: { start: number; end: number },
  meta: ThreadHighlightMeta
): void => {
  const start = offsets.start
  const end = offsets.end
  if (start < 0 || end <= start) return

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let currentOffset = 0

  const textNodes: Text[] = []
  let node = walker.nextNode() as Text | null
  while (node) {
    textNodes.push(node)
    node = walker.nextNode() as Text | null
  }

  let startNode: Text | null = null
  let startNodeOffset = 0
  let endNode: Text | null = null
  let endNodeOffset = 0

  for (const t of textNodes) {
    const len = t.nodeValue?.length ?? 0
    const nextOffset = currentOffset + len

    if (!startNode && start >= currentOffset && start <= nextOffset) {
      startNode = t
      startNodeOffset = start - currentOffset
    }

    if (!endNode && end >= currentOffset && end <= nextOffset) {
      endNode = t
      endNodeOffset = end - currentOffset
      break
    }

    currentOffset = nextOffset
  }

  if (!startNode || !endNode) return

  // If the range is within a single text node, do the simple wrap.
  if (startNode === endNode) {
    wrapTextNodePortion(startNode, startNodeOffset, endNodeOffset, meta)
    return
  }

  // Multi-node selection:
  // - wrap tail of the start node
  // - wrap full intermediate nodes
  // - wrap head of the end node
  const startIdx = textNodes.indexOf(startNode)
  const endIdx = textNodes.indexOf(endNode)
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return

  wrapTextNodePortion(startNode, startNodeOffset, startNode.nodeValue?.length ?? 0, meta)

  for (let i = startIdx + 1; i < endIdx; i += 1) {
    const t = textNodes[i]
    // Skip wrapping if this text node is already inside a highlight span (shouldn't happen
    // if callers clear existing highlights first, but keep it safe).
    if (t.parentElement?.closest?.('[data-thread-highlight="1"]')) continue
    wrapTextNodePortion(t, 0, t.nodeValue?.length ?? 0, meta)
  }

  wrapTextNodePortion(endNode, 0, endNodeOffset, meta)
}
