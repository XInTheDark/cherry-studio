import { loggerService } from '@logger'
import type { Assistant } from '@renderer/types'

import type { BlockManager } from '../BlockManager'
import { createBaseCallbacks } from './baseCallbacks'
import { createCitationCallbacks } from './citationCallbacks'
import { createCompactCallbacks } from './compactCallbacks'
import { createImageCallbacks } from './imageCallbacks'
import { createResponsesReasoningCallbacks } from './responsesReasoningCallbacks'
import { createTextCallbacks } from './textCallbacks'
import { createThinkingCallbacks } from './thinkingCallbacks'
import { createToolCallbacks } from './toolCallbacks'
import { createVideoCallbacks } from './videoCallbacks'

const logger = loggerService.withContext('messageStreamingCallbacks')

interface CallbacksDependencies {
  blockManager: BlockManager
  dispatch: any
  getState: any
  topicId: string
  assistantMsgId: string
  saveUpdatesToDB: any
  assistant: Assistant
  /**
   * When true, the stream is continuing an existing assistant message. This enables
   * appending streamed text inline into the existing MAIN_TEXT block (when possible).
   */
  isContinueMode?: boolean
}

export const createCallbacks = (deps: CallbacksDependencies) => {
  const { blockManager, dispatch, getState, topicId, assistantMsgId, saveUpdatesToDB, assistant } = deps

  // 首先创建 thinkingCallbacks ，以便传递 getCurrentThinkingInfo 给 baseCallbacks
  const thinkingCallbacks = createThinkingCallbacks({
    blockManager,
    assistantMsgId
  })

  // 创建基础回调
  const baseCallbacks = createBaseCallbacks({
    blockManager,
    dispatch,
    getState,
    topicId,
    assistantMsgId,
    saveUpdatesToDB,
    assistant,
    getCurrentThinkingInfo: thinkingCallbacks.getCurrentThinkingInfo,
    isContinueMode: deps.isContinueMode
  })

  const toolCallbacks = createToolCallbacks({
    blockManager,
    assistantMsgId,
    dispatch
  })

  const imageCallbacks = createImageCallbacks({
    blockManager,
    assistantMsgId
  })

  const citationCallbacks = createCitationCallbacks({
    blockManager,
    assistantMsgId,
    getState
  })

  const videoCallbacks = createVideoCallbacks({ blockManager, assistantMsgId })

  const responsesReasoningCallbacks = createResponsesReasoningCallbacks({
    dispatch,
    getState,
    topicId,
    assistantMsgId,
    saveUpdatesToDB
  })

  const compactCallbacks = createCompactCallbacks({
    blockManager,
    assistantMsgId,
    dispatch,
    getState,
    topicId,
    saveUpdatesToDB
  })

  // Prevent onRawData from being overridden by spread order below.
  // We'll expose the combined handler instead.
  const { onRawData: compactOnRawData, ...compactCallbacksRest } = compactCallbacks

  // Combine raw handlers (multiple modules need to observe RAW chunks)
  const onRawData = ((content: unknown, metadata?: Record<string, any>) => {
    if (responsesReasoningCallbacks.onRawData) {
      try {
        responsesReasoningCallbacks.onRawData(content, metadata)
      } catch (error) {
        logger.error('[onRawData] responsesReasoningCallbacks.onRawData failed.', error as Error, {
          assistantMsgId,
          topicId
        })
      }
    }

    if (compactOnRawData) {
      try {
        compactOnRawData(content, metadata)
      } catch (error) {
        logger.error('[onRawData] compactCallbacks.onRawData failed.', error as Error, { assistantMsgId, topicId })
      }
    }
  }) as typeof compactOnRawData

  // 创建textCallbacks时传入citationCallbacks的getCitationBlockId方法和compactCallbacks的handleTextComplete方法
  const textCallbacks = createTextCallbacks({
    blockManager,
    getState,
    assistantMsgId,
    getCitationBlockId: citationCallbacks.getCitationBlockId,
    getCitationBlockIdFromTool: toolCallbacks.getCitationBlockId,
    handleCompactTextComplete: compactCallbacks.handleTextComplete,
    isContinueMode: deps.isContinueMode
  })

  // 组合所有回调
  return {
    ...baseCallbacks,
    ...textCallbacks,
    ...thinkingCallbacks,
    ...toolCallbacks,
    ...imageCallbacks,
    ...citationCallbacks,
    ...videoCallbacks,
    ...compactCallbacksRest,
    ...responsesReasoningCallbacks,
    onRawData,
    // 清理资源的方法
    cleanup: () => {
      // 清理由 messageThunk 中的节流函数管理，这里不需要特别处理
      // 如果需要，可以调用 blockManager 的相关清理方法
    }
  }
}
