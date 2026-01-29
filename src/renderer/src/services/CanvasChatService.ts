import { loggerService } from '@logger'
import db from '@renderer/databases'
import store from '@renderer/store'
import { cloneMessagesToNewTopicThunk, loadTopicMessagesThunk } from '@renderer/store/thunk/messageThunk'
import type { Assistant, Topic } from '@renderer/types'
import { uuid } from '@renderer/utils'

import { joinFsPath, normalizeFsPath } from './canvasHistory/pathUtils'

const logger = loggerService.withContext('CanvasChatService')

const CANVAS_CHAT_TOPIC_PREFIX = 'canvas__'

export type CanvasChatEntryV1 = {
  id: string
  topicId: string
  assistantId: string
  name?: string
  createdAt: string
  updatedAt: string
}

export type CanvasChatsIndexV1 = {
  version: 1
  updatedAt: string
  lastActiveChatId?: string
  chats: CanvasChatEntryV1[]
}

function nowIso(): string {
  return new Date().toISOString()
}

function buildCanvasChatTopicId(canvasId: string, chatId: string): string {
  return `${CANVAS_CHAT_TOPIC_PREFIX}${canvasId}__${chatId}`
}

export function isCanvasChatTopicId(topicId: string): boolean {
  return topicId.startsWith(CANVAS_CHAT_TOPIC_PREFIX)
}

export function parseCanvasChatTopicId(topicId: string): { canvasId: string; chatId: string } | null {
  if (!isCanvasChatTopicId(topicId)) return null
  const raw = topicId.slice(CANVAS_CHAT_TOPIC_PREFIX.length)
  const parts = raw.split('__')
  if (parts.length !== 2) return null
  const [canvasId, chatId] = parts
  if (!canvasId || !chatId) return null
  return { canvasId, chatId }
}

let appDataPathPromise: Promise<string> | null = null

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

function getCanvasChatsDir(appDataPath: string, canvasId: string): string {
  return joinFsPath(normalizeFsPath(appDataPath), 'Data', 'Canvases', canvasId)
}

function getChatsIndexPath(appDataPath: string, canvasId: string): string {
  return joinFsPath(getCanvasChatsDir(appDataPath, canvasId), 'chats.json')
}

async function ensureDir(path: string): Promise<void> {
  try {
    await window.api.file.mkdir(path)
  } catch (error) {
    logger.debug('Failed to mkdir (ignored):', { path, error: (error as Error)?.message })
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

async function writeJson(path: string, data: unknown): Promise<void> {
  await window.api.file.write(path, JSON.stringify(data, null, 2))
}

async function loadOrCreateChatsIndex(canvasId: string): Promise<CanvasChatsIndexV1> {
  const appDataPath = await getAppDataPath()
  const indexPath = getChatsIndexPath(appDataPath, canvasId)
  const existing = await safeReadJson<CanvasChatsIndexV1>(indexPath)
  if (existing?.version === 1 && Array.isArray(existing.chats)) {
    return existing
  }
  return { version: 1, updatedAt: nowIso(), chats: [] }
}

async function saveChatsIndex(canvasId: string, index: CanvasChatsIndexV1): Promise<void> {
  const appDataPath = await getAppDataPath()
  index.updatedAt = nowIso()
  await ensureDir(getCanvasChatsDir(appDataPath, canvasId))
  await writeJson(getChatsIndexPath(appDataPath, canvasId), index)
}

async function ensureDexieTopicExists(topicId: string): Promise<void> {
  try {
    const existing = await db.topics.get(topicId)
    if (existing) return
    await db.topics.add({ id: topicId, messages: [] })
  } catch (error) {
    logger.warn('Failed to ensure Dexie topic exists (non-fatal):', error as Error)
  }
}

function buildHiddenTopicSkeleton(args: { topicId: string; assistantId: string; name: string }): Topic {
  const now = nowIso()
  return {
    id: args.topicId,
    assistantId: args.assistantId,
    name: args.name,
    createdAt: now,
    updatedAt: now,
    messages: []
  }
}

export const CanvasChatService = {
  buildCanvasChatTopicId,

  listChats: async (canvasId: string): Promise<CanvasChatsIndexV1> => {
    return loadOrCreateChatsIndex(canvasId)
  },

  setLastActiveChat: async ({ canvasId, chatId }: { canvasId: string; chatId: string }): Promise<void> => {
    const index = await loadOrCreateChatsIndex(canvasId)
    index.lastActiveChatId = chatId
    await saveChatsIndex(canvasId, index)
  },

  createChat: async ({
    canvasId,
    assistantId,
    name
  }: {
    canvasId: string
    assistantId: string
    name?: string
  }): Promise<CanvasChatEntryV1> => {
    const index = await loadOrCreateChatsIndex(canvasId)

    const chatId = uuid()
    const topicId = buildCanvasChatTopicId(canvasId, chatId)
    const now = nowIso()

    const entry: CanvasChatEntryV1 = {
      id: chatId,
      topicId,
      assistantId,
      name,
      createdAt: now,
      updatedAt: now
    }

    index.chats.push(entry)
    index.lastActiveChatId = chatId
    await saveChatsIndex(canvasId, index)

    await ensureDexieTopicExists(topicId)
    return entry
  },

  /**
   * Duplicate all chats (metadata + underlying hidden Dexie topics/messages).
   *
   * This is used by Duplicate Canvas so the clone contains the full conversation history.
   */
  duplicateChats: async ({
    sourceCanvasId,
    newCanvasId
  }: {
    sourceCanvasId: string
    newCanvasId: string
  }): Promise<void> => {
    const sourceIndex = await loadOrCreateChatsIndex(sourceCanvasId)
    if (sourceIndex.chats.length === 0) {
      // Keep destination empty; it will lazily create the first chat when opened.
      return
    }

    const dispatch = store.dispatch as any
    const destIndex: CanvasChatsIndexV1 = { version: 1, updatedAt: nowIso(), chats: [] }

    // Map old chatId -> new chatId for lastActiveChatId.
    const mappedChatIds = new Map<string, string>()

    for (const chat of sourceIndex.chats) {
      const newChatId = uuid()
      mappedChatIds.set(chat.id, newChatId)

      const newTopicId = buildCanvasChatTopicId(newCanvasId, newChatId)
      const now = nowIso()

      destIndex.chats.push({
        id: newChatId,
        topicId: newTopicId,
        assistantId: chat.assistantId,
        name: chat.name,
        createdAt: now,
        updatedAt: now
      })

      // Ensure both topics exist and are loaded into store before cloning.
      await ensureDexieTopicExists(newTopicId)

      try {
        // Ensure source messages/blocks are present in redux state so the clone thunk can reuse them.
        await dispatch(loadTopicMessagesThunk(chat.topicId, true) as any)

        const newTopic: Topic = buildHiddenTopicSkeleton({
          topicId: newTopicId,
          assistantId: chat.assistantId,
          name: chat.name || 'Canvas Chat'
        })

        // Clone *all* messages (branchPointIndex > len => clones full).
        await dispatch(cloneMessagesToNewTopicThunk(chat.topicId, Number.MAX_SAFE_INTEGER, newTopic) as any)
      } catch (error) {
        // Non-fatal: keep metadata + empty topic.
        logger.warn('Failed to duplicate canvas chat topic (non-fatal):', {
          sourceTopicId: chat.topicId,
          newTopicId,
          error: (error as Error)?.message
        })
      }
    }

    const sourceLast = sourceIndex.lastActiveChatId
    destIndex.lastActiveChatId = sourceLast ? mappedChatIds.get(sourceLast) : destIndex.chats[0]?.id
    await saveChatsIndex(newCanvasId, destIndex)
  },

  /**
   * Helper for CanvasChatSidebar: ensure at least one chat exists for the canvas.
   */
  ensureAtLeastOneChat: async ({
    canvasId,
    defaultAssistantId
  }: {
    canvasId: string
    defaultAssistantId: string
  }): Promise<{ index: CanvasChatsIndexV1; activeChat: CanvasChatEntryV1 }> => {
    if (!defaultAssistantId) {
      throw new Error('Missing defaultAssistantId for canvas chat')
    }
    const index = await loadOrCreateChatsIndex(canvasId)
    if (index.chats.length === 0) {
      const created = await CanvasChatService.createChat({
        canvasId,
        assistantId: defaultAssistantId,
        name: undefined
      })
      const nextIndex = await loadOrCreateChatsIndex(canvasId)
      return { index: nextIndex, activeChat: created }
    }

    const activeId = index.lastActiveChatId ?? index.chats[0]?.id
    const active = index.chats.find((c) => c.id === activeId) ?? index.chats[0]
    if (!active) {
      const created = await CanvasChatService.createChat({
        canvasId,
        assistantId: defaultAssistantId,
        name: undefined
      })
      const nextIndex = await loadOrCreateChatsIndex(canvasId)
      return { index: nextIndex, activeChat: created }
    }
    return { index, activeChat: active }
  },

  getAssistantName: (assistantId: string): string => {
    const state = store.getState()
    const assistant: Assistant | undefined = state.assistants.assistants.find((a: Assistant) => a.id === assistantId)
    return assistant?.name ?? assistantId
  }
}

export default CanvasChatService
