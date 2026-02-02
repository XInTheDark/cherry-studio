import { loggerService } from '@logger'
import { WebSearchSource } from '@renderer/types'
import type { CitationMessageBlock, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { createMainTextBlock } from '@renderer/utils/messageUtils/create'

import type { BlockManager } from '../BlockManager'

const logger = loggerService.withContext('TextCallbacks')

interface TextCallbacksDependencies {
  blockManager: BlockManager
  getState: any
  assistantMsgId: string
  getCitationBlockId: () => string | null
  getCitationBlockIdFromTool: () => string | null
  handleCompactTextComplete?: (text: string, mainTextBlockId: string | null) => Promise<boolean>
  /**
   * When true, the stream is continuing an existing assistant message. If the
   * message currently ends with a MAIN_TEXT block, we will reuse that block and
   * append streamed text inline (instead of creating a new paragraph-like block).
   */
  isContinueMode?: boolean
}

export const createTextCallbacks = (deps: TextCallbacksDependencies) => {
  const {
    blockManager,
    getState,
    assistantMsgId,
    getCitationBlockId,
    getCitationBlockIdFromTool,
    handleCompactTextComplete,
    isContinueMode
  } = deps

  // 内部维护的状态
  let mainTextBlockId: string | null = null
  let continuePrefixText = ''
  let continueBaselineCitationReferences: any[] = []

  return {
    getCurrentMainTextBlockId: () => mainTextBlockId,
    onTextStart: async () => {
      // Continue mode: if the existing assistant message ends with a MAIN_TEXT block,
      // reuse it so the continued output starts inline (no extra paragraph spacing).
      if (isContinueMode) {
        const state = getState()
        const message = state.messages.entities[assistantMsgId]
        const lastBlockId = message?.blocks?.length ? String(message.blocks[message.blocks.length - 1]) : null
        const lastBlock = lastBlockId ? state.messageBlocks.entities[lastBlockId] : null

        if (lastBlockId && lastBlock?.type === MessageBlockType.MAIN_TEXT) {
          mainTextBlockId = lastBlockId
          continuePrefixText = typeof (lastBlock as any).content === 'string' ? (lastBlock as any).content : ''
          continueBaselineCitationReferences = Array.isArray((lastBlock as any).citationReferences)
            ? (lastBlock as any).citationReferences
            : []

          // Make BlockManager treat this as the active streaming block.
          blockManager.lastBlockType = MessageBlockType.MAIN_TEXT
          blockManager.activeBlockInfo = { id: lastBlockId, type: MessageBlockType.MAIN_TEXT }

          // Update status to STREAMING while keeping the existing content.
          // Use an immediate update to avoid UI delays.
          blockManager.smartBlockUpdate(
            lastBlockId,
            {
              type: MessageBlockType.MAIN_TEXT,
              content: continuePrefixText,
              status: MessageBlockStatus.STREAMING
            },
            MessageBlockType.MAIN_TEXT,
            true
          )

          // Restore active state after the immediate update (smartBlockUpdate clears it when isComplete=true).
          blockManager.lastBlockType = MessageBlockType.MAIN_TEXT
          blockManager.activeBlockInfo = { id: lastBlockId, type: MessageBlockType.MAIN_TEXT }
          return
        }
      }

      if (blockManager.hasInitialPlaceholder) {
        const changes = {
          type: MessageBlockType.MAIN_TEXT,
          content: '',
          status: MessageBlockStatus.STREAMING
        }
        mainTextBlockId = blockManager.initialPlaceholderBlockId!
        blockManager.smartBlockUpdate(mainTextBlockId, changes, MessageBlockType.MAIN_TEXT, true)
      } else if (!mainTextBlockId) {
        const newBlock = createMainTextBlock(assistantMsgId, '', {
          status: MessageBlockStatus.STREAMING
        })
        mainTextBlockId = newBlock.id
        await blockManager.handleBlockTransition(newBlock, MessageBlockType.MAIN_TEXT)
      }
    },

    onTextChunk: async (text: string) => {
      const citationBlockId = getCitationBlockId() || getCitationBlockIdFromTool()
      const citationBlockSource = citationBlockId
        ? (getState().messageBlocks.entities[citationBlockId] as CitationMessageBlock).response?.source
        : WebSearchSource.WEBSEARCH
      if (text) {
        const baseRefs = isContinueMode ? continueBaselineCitationReferences : []
        const nextRefs = (() => {
          if (!citationBlockId) return baseRefs

          // Avoid duplicating refs across multiple deltas in continue mode.
          const exists = baseRefs.some((ref: any) => ref?.citationBlockId === citationBlockId)
          if (exists) return baseRefs
          return [...baseRefs, { citationBlockId, citationBlockSource }]
        })()

        const blockChanges: Partial<MessageBlock> = {
          content: isContinueMode ? `${continuePrefixText}${text}` : text,
          status: MessageBlockStatus.STREAMING,
          citationReferences: isContinueMode
            ? nextRefs
            : citationBlockId
              ? [{ citationBlockId, citationBlockSource }]
              : []
        }
        blockManager.smartBlockUpdate(mainTextBlockId!, blockChanges, MessageBlockType.MAIN_TEXT)
      }
    },

    onTextComplete: async (finalText: string) => {
      if (mainTextBlockId) {
        const changes = {
          content: isContinueMode ? `${continuePrefixText}${finalText}` : finalText,
          status: MessageBlockStatus.SUCCESS
        }
        blockManager.smartBlockUpdate(mainTextBlockId, changes, MessageBlockType.MAIN_TEXT, true)
        if (handleCompactTextComplete) {
          await handleCompactTextComplete(finalText, mainTextBlockId)
        }
        mainTextBlockId = null
        continuePrefixText = ''
        continueBaselineCitationReferences = []
      } else {
        logger.warn(
          `[onTextComplete] Received text.complete but last block was not MAIN_TEXT (was ${blockManager.lastBlockType}) or lastBlockId is null.`
        )
      }
    }
  }
}
