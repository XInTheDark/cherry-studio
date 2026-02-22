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
import CanvasChatService, { parseCanvasChatTopicId } from '@renderer/services/CanvasChatService'
import CanvasCommentService from '@renderer/services/CanvasCommentService'
import CanvasHistoryService from '@renderer/services/CanvasHistoryService'
import CanvasTopicMappingService from '@renderer/services/CanvasTopicMappingService'
import store from '@renderer/store'
import type { Assistant } from '@renderer/types'

import {
  canvasAddCommentTool,
  canvasAppendTool,
  canvasCreateTool,
  canvasListTool,
  canvasReadTool,
  canvasReplaceTool
} from '../tools/CanvasTools'

const logger = loggerService.withContext('CanvasOrchestrationPlugin')

const CANVAS_CONTEXT_MARKER = '[[CANVAS_CONTEXT]]'

function buildCanvasContextMessage(args: {
  canvasId: string
  relPath: string
  markdown: string
  unresolvedComments: Array<{ id: string; type: string; comment: string; anchorPreview: string; replyCount: number }>
}): string {
  const { canvasId, relPath, markdown, unresolvedComments } = args
  const commentLines =
    unresolvedComments.length === 0
      ? ['- (none)']
      : unresolvedComments.map((item, idx) => {
          const summary = item.comment.replace(/\s+/g, ' ').slice(0, 200)
          const anchor = item.anchorPreview.replace(/\s+/g, ' ').slice(0, 160)
          return `${idx + 1}. id=${item.id} type=${item.type} replies=${item.replyCount}\n   anchor: ${anchor}\n   comment: ${summary}`
        })

  return [
    CANVAS_CONTEXT_MARKER,
    'You have Canvas context for this request. Keep edits consistent with the current markdown and open comments.',
    `canvasId: ${canvasId}`,
    `relPath: ${relPath}`,
    '',
    'Current markdown:',
    '```markdown',
    markdown,
    '```',
    '',
    'Open comments (unresolved):',
    ...commentLines
  ].join('\n')
}

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
          // Normal chat: prefer persistent topic -> activeCanvasId mapping.
          const mappedCanvasId = await CanvasTopicMappingService.getActiveCanvasId(topicId)
          if (mappedCanvasId) {
            const resolved = await CanvasHistoryService.resolveFilePathForCanvasId({
              notesPath,
              canvasId: mappedCanvasId
            })
            if (resolved?.filePath) {
              defaultTarget = { canvasId: mappedCanvasId, filePath: resolved.filePath }
            }
          }

          if (!defaultTarget) {
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

        // Inject the latest canvas markdown + unresolved comments for each canvas-enabled request.
        if (defaultTarget) {
          try {
            const resolved = await CanvasHistoryService.resolveFilePathForCanvasId({
              notesPath,
              canvasId: defaultTarget.canvasId
            })
            const relPath = resolved?.relPath || defaultTarget.filePath
            const markdown = await window.api.fs.readText(defaultTarget.filePath)
            const commentsIndex = await CanvasCommentService.listComments(defaultTarget.canvasId)
            const unresolved = commentsIndex.comments
              .filter((item) => item.status !== 'resolved')
              .map((item) => ({
                id: item.id,
                type: item.type,
                comment: item.content,
                anchorPreview: item.anchorPreview,
                replyCount: item.replies.length
              }))

            const contextMessage = buildCanvasContextMessage({
              canvasId: defaultTarget.canvasId,
              relPath,
              markdown,
              unresolvedComments: unresolved
            })

            const existingMessages = Array.isArray(params.messages) ? params.messages : []
            const alreadyInjected = existingMessages.some(
              (msg: any) =>
                msg?.role === 'system' &&
                typeof msg?.content === 'string' &&
                msg.content.includes(CANVAS_CONTEXT_MARKER)
            )
            if (!alreadyInjected) {
              params.messages = [{ role: 'system', content: contextMessage }, ...existingMessages]
            }
          } catch (error) {
            logger.warn('Failed to inject canvas context (continuing without injection):', error as Error)
          }
        }

        // Inject tools. Names must start with builtin_ to be rendered as builtin tool blocks.
        params.tools['builtin_canvas_read'] = canvasReadTool({ notesPath, defaultTarget })
        params.tools['builtin_canvas_list'] = canvasListTool({ notesPath })
        params.tools['builtin_canvas_create'] = canvasCreateTool({
          notesPath,
          defaultFolderRelPath: 'From Chat',
          onCreated: async (created) => {
            await CanvasTopicMappingService.setActiveCanvasId({ topicId, canvasId: created.canvasId })

            if (!isCanvasChat) {
              const state = store.getState()
              const allTopics = state.assistants.assistants.flatMap((item) => item.topics || [])
              const currentTopic = allTopics.find((item) => item.id === topicId)

              try {
                await CanvasChatService.associateTopicWithCanvas({
                  canvasId: created.canvasId,
                  topicId,
                  assistantId: currentTopic?.assistantId || assistant.id,
                  name: currentTopic?.name,
                  origin: 'main-chat'
                })
              } catch (error) {
                logger.warn('Failed to associate main chat topic with newly created canvas:', {
                  topicId,
                  canvasId: created.canvasId,
                  error: (error as Error)?.message
                })
              }
            }
          }
        })
        params.tools['builtin_canvas_replace'] = canvasReplaceTool({ notesPath, defaultTarget })
        params.tools['builtin_canvas_append'] = canvasAppendTool({ notesPath, defaultTarget })
        params.tools['builtin_canvas_add_comment'] = canvasAddCommentTool({ notesPath, defaultTarget })

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
