export type ThreadTopicRef = {
  parentTopicId: string
  parentMessageId: string
  threadId: string
}

// Selection anchor for "comment-style" highlights inside a message block.
// We store a quote selector (exact + prefix/suffix) for robustness, with offsets as a fallback.
export type ThreadAnchor = {
  blockId: string
  exact: string
  prefix?: string
  suffix?: string
  startOffset?: number
  endOffset?: number
}

export type ThreadSummary = {
  id: string
  topicId: string
  createdAt: string
  updatedAt: string
  starterPrompt: string
  // Number of context messages cloned into the thread topic (hidden in the thread UI).
  contextCount: number
  anchor?: ThreadAnchor
}
