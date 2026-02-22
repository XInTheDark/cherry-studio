export type CanvasCommentType = 'important' | 'suggestion' | 'question' | 'none'

export type CanvasCommentStatus = 'open' | 'resolved'

export type CanvasCommentAuthor = 'human' | 'assistant' | 'system'

export type CanvasChatOrigin = 'canvas' | 'main-chat' | 'thread'

export type CanvasCommentAnchor = {
  exact: string
  prefix?: string
  suffix?: string
  startOffset?: number
  endOffset?: number
}

export type CanvasCommentReply = {
  id: string
  content: string
  author: CanvasCommentAuthor
  createdAt: string
  updatedAt: string
}

export type CanvasCommentEntry = {
  id: string
  canvasId: string
  type: CanvasCommentType
  content: string
  status: CanvasCommentStatus
  anchor: CanvasCommentAnchor
  anchorPreview: string
  createdBy: CanvasCommentAuthor
  createdAt: string
  updatedAt: string
  resolvedAt?: string
  resolvedBy?: CanvasCommentAuthor
  replies: CanvasCommentReply[]
}

export type CanvasCommentsIndexV1 = {
  version: 1
  updatedAt: string
  comments: CanvasCommentEntry[]
}
