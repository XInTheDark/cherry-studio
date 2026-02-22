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
const CANVAS_SELECTED_CONTEXT_MARKER = '[[CANVAS_SELECTED_CONTEXT]]'
const MAX_SELECTED_CANVAS_COUNT = 5
const MAX_SELECTED_CANVAS_CHARS = 6000

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

function truncateForPrompt(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false }
  }
  return { text: `${value.slice(0, maxChars)}\n\n...[truncated]`, truncated: true }
}

function buildSelectedCanvasContextMessage(args: {
  canvases: Array<{
    canvasId: string
    relPath: string
    markdown: string
    unresolvedComments: Array<{ id: string; type: string; comment: string; anchorPreview: string; replyCount: number }>
    truncated: boolean
  }>
}): string {
  const sections = args.canvases.map((canvas, idx) => {
    const comments =
      canvas.unresolvedComments.length === 0
        ? '- (none)'
        : canvas.unresolvedComments
            .map((item) => {
              const summary = item.comment.replace(/\s+/g, ' ').slice(0, 160)
              return `- id=${item.id} type=${item.type} replies=${item.replyCount}: ${summary}`
            })
            .join('\n')

    const truncatedHint = canvas.truncated ? '\n(Note: markdown was truncated for prompt budget.)' : ''

    return [
      `### ${idx + 1}. ${canvas.relPath}`,
      `canvasId: ${canvas.canvasId}`,
      '```markdown',
      canvas.markdown,
      '```',
      truncatedHint,
      'Open comments:',
      comments
    ]
      .filter(Boolean)
      .join('\n')
  })

  return [
    CANVAS_SELECTED_CONTEXT_MARKER,
    'The user selected specific canvases for this chat. Prefer these canvases when resolving references.',
    ...sections
  ].join('\n\n')
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

        const selectedCanvasIds = Array.isArray(assistant.canvasToolSelectedCanvasIds)
          ? assistant.canvasToolSelectedCanvasIds.filter(Boolean)
          : []
        const hasSpecificCanvasSelection =
          !isCanvasChat && assistant.canvasToolMode === 'specific' && selectedCanvasIds.length > 0
        const enabledForNormalChat = assistant.enableCanvas === true || hasSpecificCanvasSelection
        if (!isCanvasChat && !enabledForNormalChat) {
          return params
        }

        // Ensure tools container exists.
        if (!params.tools) {
          params.tools = {}
        }

        // Compute the default canvas target for this request.
        let defaultTarget: { canvasId: string; filePath: string } | null = null
        const selectedTargets: Array<{ canvasId: string; filePath: string; relPath: string }> = []

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
          if (hasSpecificCanvasSelection) {
            const preferredCanvasIds = selectedCanvasIds.slice(0, MAX_SELECTED_CANVAS_COUNT)
            for (const canvasId of preferredCanvasIds) {
              const resolved = await CanvasHistoryService.resolveFilePathForCanvasId({
                notesPath,
                canvasId
              })
              if (!resolved?.filePath) continue
              selectedTargets.push({
                canvasId,
                filePath: resolved.filePath,
                relPath: resolved.relPath
              })
            }
            if (selectedTargets[0]) {
              defaultTarget = {
                canvasId: selectedTargets[0].canvasId,
                filePath: selectedTargets[0].filePath
              }
            }
          }

          // Normal chat: prefer persistent topic -> activeCanvasId mapping.
          if (!defaultTarget) {
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

        // Inject latest canvas context (default target + explicitly selected canvases when applicable).
        try {
          const existingMessages = Array.isArray(params.messages) ? params.messages : []
          const injectedMessages: Array<{ role: 'system'; content: string }> = []

          if (defaultTarget) {
            const alreadyInjectedDefault = existingMessages.some(
              (msg: any) =>
                msg?.role === 'system' &&
                typeof msg?.content === 'string' &&
                msg.content.includes(CANVAS_CONTEXT_MARKER)
            )
            if (!alreadyInjectedDefault) {
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
              injectedMessages.push({ role: 'system', content: contextMessage })
            }
          }

          if (selectedTargets.length > 0) {
            const alreadyInjectedSelected = existingMessages.some(
              (msg: any) =>
                msg?.role === 'system' &&
                typeof msg?.content === 'string' &&
                msg.content.includes(CANVAS_SELECTED_CONTEXT_MARKER)
            )

            if (!alreadyInjectedSelected) {
              const selectedPayload: Array<{
                canvasId: string
                relPath: string
                markdown: string
                unresolvedComments: Array<{
                  id: string
                  type: string
                  comment: string
                  anchorPreview: string
                  replyCount: number
                }>
                truncated: boolean
              }> = []
              for (const target of selectedTargets.slice(0, MAX_SELECTED_CANVAS_COUNT)) {
                try {
                  const markdownRaw = await window.api.fs.readText(target.filePath)
                  const truncated = truncateForPrompt(markdownRaw, MAX_SELECTED_CANVAS_CHARS)
                  const commentsIndex = await CanvasCommentService.listComments(target.canvasId)
                  const unresolved = commentsIndex.comments
                    .filter((item) => item.status !== 'resolved')
                    .map((item) => ({
                      id: item.id,
                      type: item.type,
                      comment: item.content,
                      anchorPreview: item.anchorPreview,
                      replyCount: item.replies.length
                    }))
                  selectedPayload.push({
                    canvasId: target.canvasId,
                    relPath: target.relPath,
                    markdown: truncated.text,
                    unresolvedComments: unresolved,
                    truncated: truncated.truncated
                  })
                } catch (error) {
                  logger.debug('Failed to load selected canvas context (ignored):', {
                    canvasId: target.canvasId,
                    error: (error as Error)?.message
                  })
                }
              }

              if (selectedPayload.length > 0) {
                injectedMessages.push({
                  role: 'system',
                  content: buildSelectedCanvasContextMessage({
                    canvases: selectedPayload
                  })
                })
              }
            }
          }

          if (injectedMessages.length > 0) {
            params.messages = [...injectedMessages, ...existingMessages]
          }
        } catch (error) {
          logger.warn('Failed to inject canvas context (continuing without injection):', error as Error)
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
          hasDefaultTarget: !!defaultTarget,
          hasSpecificCanvasSelection,
          selectedCanvasCount: selectedTargets.length
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
