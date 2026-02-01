/**
 * Canvas orchestration plugin
 *
 * Adds builtin canvas tools when:
 * - The request is from a Canvas chat topic (topicId starts with "canvas__") => always enabled
 * - Or the user toggled Canvas tools on for a normal chat (assistant.enableCanvas === true)
 *
 * Tools apply edits immediately (write to file) and create version history entries.
 */
import { type AiRequestContext, definePlugin } from '@cherrystudio/ai-core'
import { loggerService } from '@logger'
import { parseCanvasChatTopicId } from '@renderer/services/CanvasChatService'
import CanvasHistoryService from '@renderer/services/CanvasHistoryService'
import store from '@renderer/store'
import type { Assistant } from '@renderer/types'

import {
  canvasAppendTool,
  canvasCreateTool,
  canvasListTool,
  canvasReadTool,
  canvasReplaceTool
} from '../tools/CanvasTools'

const logger = loggerService.withContext('CanvasOrchestrationPlugin')

const lastCreatedCanvasByTopicId = new Map<string, { canvasId: string; filePath: string }>()

export const canvasOrchestrationPlugin = (assistant: Assistant, topicId: string) => {
  return definePlugin({
    name: 'canvas-orchestration',

    transformParams: async (params: any, context: AiRequestContext) => {
      try {
        if (!topicId) return params

        const notesPath = store.getState().note.notesPath as string | undefined
        if (!notesPath) return params

        const parsedCanvasChat = parseCanvasChatTopicId(topicId)
        const isCanvasChat = Boolean(parsedCanvasChat)

        const enabledForNormalChat = assistant.enableCanvas === true
        if (!isCanvasChat && !enabledForNormalChat) {
          return params
        }

        // Ensure tools container exists.
        if (!params.tools) {
          params.tools = {}
        }

        // Compute the default canvas target for this request.
        let defaultTarget: { canvasId: string; filePath: string } | null = null

        if (isCanvasChat && parsedCanvasChat) {
          const resolved = await CanvasHistoryService.resolveFilePathForCanvasId({
            notesPath,
            canvasId: parsedCanvasChat.canvasId
          })
          if (resolved) {
            defaultTarget = { canvasId: parsedCanvasChat.canvasId, filePath: resolved.filePath }
          } else {
            logger.warn('Canvas chat topicId has canvasId not present in mapping index:', {
              topicId,
              canvasId: parsedCanvasChat.canvasId
            })
          }
        } else {
          // Normal chat: prefer the last canvas created by this topic (in-memory).
          const lastCreated = lastCreatedCanvasByTopicId.get(topicId)
          if (lastCreated) {
            defaultTarget = lastCreated
          } else {
            // Fallback to the currently active canvas selected in Notes (best-effort).
            const activeFilePath = store.getState().note.activeFilePath as string | undefined
            if (activeFilePath) {
              try {
                const { canvasId } = await CanvasHistoryService.getCanvasId({ notesPath, filePath: activeFilePath })
                defaultTarget = { canvasId, filePath: activeFilePath }
              } catch {
                // ignore
              }
            }
          }
        }

        // Inject tools. Names must start with builtin_ to be rendered as builtin tool blocks.
        params.tools['builtin_canvas_read'] = canvasReadTool({ notesPath, defaultTarget })
        params.tools['builtin_canvas_list'] = canvasListTool({ notesPath })
        params.tools['builtin_canvas_create'] = canvasCreateTool({
          notesPath,
          defaultFolderRelPath: 'From Chat',
          onCreated: (created) => {
            lastCreatedCanvasByTopicId.set(topicId, created)
          }
        })
        params.tools['builtin_canvas_replace'] = canvasReplaceTool({ notesPath, defaultTarget })
        params.tools['builtin_canvas_append'] = canvasAppendTool({ notesPath, defaultTarget })

        logger.debug('Canvas tools enabled for request', {
          requestId: context.requestId,
          topicId,
          isCanvasChat,
          enabledForNormalChat,
          hasDefaultTarget: !!defaultTarget
        })

        return params
      } catch (error) {
        logger.error('Failed to configure canvas tools:', error as Error)
        return params
      }
    }
  })
}

export default canvasOrchestrationPlugin
