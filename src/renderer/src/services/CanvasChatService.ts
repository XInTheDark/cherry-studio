import { loggerService } from '@logger'
import db from '@renderer/databases'
import store from '@renderer/store'
import { cloneMessagesToNewTopicThunk, loadTopicMessagesThunk } from '@renderer/store/thunk/messageThunk'
import type { Assistant, CanvasChatOrigin, ConversationThreadRecord, Topic } from '@renderer/types'
import { uuid } from '@renderer/utils'

import { joinFsPath, normalizeFsPath } from './canvasHistory/pathUtils'

const logger = loggerService.withContext('CanvasChatService')

const CANVAS_CHAT_TOPIC_PREFIX = 'canvas__'
const CANVAS_THREAD_SCOPE = 'canvas' as const

export type CanvasChatEntryV1 = {
  id: string
  topicId: string
  assistantId: string
  origin?: CanvasChatOrigin
  name?: string
  createdAt: string
  updatedAt: string
  isNameManuallyEdited?: boolean
  lastActiveAt?: string
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

function getLegacyChatsIndexPath(appDataPath: string, canvasId: string): string {
  return joinFsPath(getCanvasChatsDir(appDataPath, canvasId), 'chats.json')
}

async function safeReadJson<T>(path: string): Promise<T | null> {
  try {
    const text = await window.api.fs.readText(path)
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function sortByUpdatedDesc(a: ConversationThreadRecord, b: ConversationThreadRecord): number {
  if (a.updatedAt !== b.updatedAt) {
    return a.updatedAt < b.updatedAt ? 1 : -1
  }
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1
  }
  return a.id < b.id ? 1 : -1
}

function getLastActiveChatId(records: ConversationThreadRecord[]): string | undefined {
  let winner: ConversationThreadRecord | undefined

  for (const record of records) {
    if (!record.lastActiveAt) continue
    if (!winner) {
      winner = record
      continue
    }

    if ((winner.lastActiveAt || '') < record.lastActiveAt) {
      winner = record
    }
  }

  return winner?.id
}

function toCanvasChatEntry(record: ConversationThreadRecord): CanvasChatEntryV1 {
  return {
    id: record.id,
    topicId: record.topicId,
    assistantId: record.assistantId,
    origin: record.origin,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    isNameManuallyEdited: record.isNameManuallyEdited,
    lastActiveAt: record.lastActiveAt
  }
}

function buildCanvasIndex(records: ConversationThreadRecord[]): CanvasChatsIndexV1 {
  const sorted = [...records].sort(sortByUpdatedDesc)
  return {
    version: 1,
    updatedAt: sorted[0]?.updatedAt || nowIso(),
    lastActiveChatId: getLastActiveChatId(sorted),
    chats: sorted.map(toCanvasChatEntry)
  }
}

function normalizeChatName(name: string | undefined): string | undefined {
  const trimmed = name?.trim() || ''
  return trimmed.length > 0 ? trimmed : undefined
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

async function removeTopicData(topicId: string): Promise<void> {
  try {
    const topic = await db.topics.get(topicId)
    if (topic?.messages?.length) {
      const blockIds = topic.messages.flatMap((message) => message.blocks || [])
      if (blockIds.length > 0) {
        await db.message_blocks.bulkDelete(blockIds)
      }
    }

    await db.topics.delete(topicId)
  } catch (error) {
    logger.warn('Failed to delete topic data for canvas chat (non-fatal):', {
      topicId,
      error: (error as Error)?.message
    })
  }
}

const migratedCanvasIds = new Set<string>()
const migrationLocks = new Map<string, Promise<void>>()

async function migrateLegacyCanvasChatsIfNeeded(canvasId: string): Promise<void> {
  if (!canvasId) return
  if (migratedCanvasIds.has(canvasId)) return

  const pending = migrationLocks.get(canvasId)
  if (pending) {
    await pending
    return
  }

  const task = (async () => {
    const existingCount = await db.conversation_threads
      .where('canvasId')
      .equals(canvasId)
      .and((record) => record.scope === CANVAS_THREAD_SCOPE)
      .count()

    if (existingCount > 0) {
      migratedCanvasIds.add(canvasId)
      return
    }

    let appDataPath: string
    try {
      appDataPath = await getAppDataPath()
    } catch {
      migratedCanvasIds.add(canvasId)
      return
    }

    const legacyPath = getLegacyChatsIndexPath(appDataPath, canvasId)
    const legacy = await safeReadJson<CanvasChatsIndexV1>(legacyPath)

    if (!legacy || legacy.version !== 1 || !Array.isArray(legacy.chats) || legacy.chats.length === 0) {
      migratedCanvasIds.add(canvasId)
      return
    }

    const imported: ConversationThreadRecord[] = []

    for (const chat of legacy.chats) {
      if (!chat?.id || !chat?.assistantId) continue

      const existing = await db.conversation_threads.get(chat.id)
      if (existing) continue

      imported.push({
        id: chat.id,
        topicId: chat.topicId || buildCanvasChatTopicId(canvasId, chat.id),
        scope: CANVAS_THREAD_SCOPE,
        canvasId,
        assistantId: chat.assistantId,
        origin: chat.topicId && !isCanvasChatTopicId(chat.topicId) ? 'main-chat' : 'canvas',
        name: normalizeChatName(chat.name),
        isNameManuallyEdited: chat.isNameManuallyEdited,
        createdAt: chat.createdAt || nowIso(),
        updatedAt: chat.updatedAt || chat.createdAt || nowIso(),
        lastActiveAt: legacy.lastActiveChatId === chat.id ? legacy.updatedAt || chat.updatedAt || nowIso() : undefined
      })
    }

    if (imported.length > 0) {
      await db.conversation_threads.bulkPut(imported)
      logger.info('Migrated legacy canvas chats from file index', {
        canvasId,
        count: imported.length
      })
    }

    migratedCanvasIds.add(canvasId)
  })().finally(() => {
    migrationLocks.delete(canvasId)
  })

  migrationLocks.set(canvasId, task)
  await task
}

async function listCanvasThreadRecords(canvasId: string): Promise<ConversationThreadRecord[]> {
  await migrateLegacyCanvasChatsIfNeeded(canvasId)

  const records = await db.conversation_threads.where('canvasId').equals(canvasId).toArray()
  return records.filter((record) => record.scope === CANVAS_THREAD_SCOPE).sort(sortByUpdatedDesc)
}

async function getCanvasThreadRecord(canvasId: string, chatId: string): Promise<ConversationThreadRecord | null> {
  await migrateLegacyCanvasChatsIfNeeded(canvasId)
  const record = await db.conversation_threads.get(chatId)
  if (!record) return null
  if (record.scope !== CANVAS_THREAD_SCOPE || record.canvasId !== canvasId) return null
  return record
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
    const records = await listCanvasThreadRecords(canvasId)
    return buildCanvasIndex(records)
  },

  setLastActiveChat: async ({ canvasId, chatId }: { canvasId: string; chatId: string }): Promise<void> => {
    const target = await getCanvasThreadRecord(canvasId, chatId)
    if (!target) return

    await db.conversation_threads.update(chatId, { lastActiveAt: nowIso() })
  },

  touchChat: async ({ canvasId, chatId }: { canvasId: string; chatId: string }): Promise<void> => {
    const target = await getCanvasThreadRecord(canvasId, chatId)
    if (!target) return

    await db.conversation_threads.update(chatId, { updatedAt: nowIso() })
  },

  touchChatByTopicId: async ({ canvasId, topicId }: { canvasId: string; topicId: string }): Promise<void> => {
    if (!canvasId || !topicId) return

    await migrateLegacyCanvasChatsIfNeeded(canvasId)

    const target = await db.conversation_threads
      .where('topicId')
      .equals(topicId)
      .and((record) => record.scope === CANVAS_THREAD_SCOPE && record.canvasId === canvasId)
      .first()
    if (!target) return

    const now = nowIso()
    await db.conversation_threads.update(target.id, {
      updatedAt: now,
      lastActiveAt: now
    })
  },

  renameChat: async ({
    canvasId,
    chatId,
    name,
    isNameManuallyEdited
  }: {
    canvasId: string
    chatId: string
    name: string
    isNameManuallyEdited?: boolean
  }): Promise<CanvasChatEntryV1 | null> => {
    const target = await getCanvasThreadRecord(canvasId, chatId)
    if (!target) return null

    const now = nowIso()
    const nextName = normalizeChatName(name)
    await db.conversation_threads.update(chatId, {
      name: nextName,
      updatedAt: now,
      isNameManuallyEdited:
        typeof isNameManuallyEdited === 'boolean' ? isNameManuallyEdited : (target.isNameManuallyEdited ?? false)
    })

    const updated = await getCanvasThreadRecord(canvasId, chatId)
    return updated ? toCanvasChatEntry(updated) : null
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
    await migrateLegacyCanvasChatsIfNeeded(canvasId)

    const chatId = uuid()
    const topicId = buildCanvasChatTopicId(canvasId, chatId)
    const now = nowIso()

    const record: ConversationThreadRecord = {
      id: chatId,
      topicId,
      scope: CANVAS_THREAD_SCOPE,
      canvasId,
      origin: 'canvas',
      assistantId,
      name: normalizeChatName(name),
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
      isNameManuallyEdited: false
    }

    await db.conversation_threads.add(record)
    await ensureDexieTopicExists(topicId)

    return toCanvasChatEntry(record)
  },

  associateTopicWithCanvas: async ({
    canvasId,
    topicId,
    assistantId,
    name,
    origin = 'main-chat'
  }: {
    canvasId: string
    topicId: string
    assistantId: string
    name?: string
    origin?: CanvasChatOrigin
  }): Promise<CanvasChatEntryV1> => {
    if (!canvasId || !topicId || !assistantId) {
      throw new Error('Missing canvas/topic/assistant for association')
    }

    await migrateLegacyCanvasChatsIfNeeded(canvasId)

    const existing = await db.conversation_threads
      .where('topicId')
      .equals(topicId)
      .and((record) => record.scope === CANVAS_THREAD_SCOPE && record.canvasId === canvasId)
      .first()

    const now = nowIso()
    if (existing) {
      await db.conversation_threads.update(existing.id, {
        assistantId,
        name: normalizeChatName(name) || existing.name,
        origin,
        updatedAt: now,
        lastActiveAt: now
      })
      const next = await db.conversation_threads.get(existing.id)
      if (!next) {
        throw new Error('Failed to read updated canvas-topic association')
      }
      await ensureDexieTopicExists(topicId)
      return toCanvasChatEntry(next)
    }

    const record: ConversationThreadRecord = {
      id: uuid(),
      topicId,
      scope: CANVAS_THREAD_SCOPE,
      canvasId,
      origin,
      assistantId,
      name: normalizeChatName(name),
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
      isNameManuallyEdited: false
    }

    await db.conversation_threads.add(record)
    await ensureDexieTopicExists(topicId)
    return toCanvasChatEntry(record)
  },

  deleteChat: async ({
    canvasId,
    chatId,
    removeTopic = true
  }: {
    canvasId: string
    chatId: string
    removeTopic?: boolean
  }): Promise<{ index: CanvasChatsIndexV1; activeChatId: string | null }> => {
    const records = await listCanvasThreadRecords(canvasId)
    if (records.length <= 1) {
      throw new Error('Cannot delete the last canvas chat')
    }

    const target = records.find((record) => record.id === chatId)
    if (!target) {
      const nextIndex = buildCanvasIndex(records)
      return {
        index: nextIndex,
        activeChatId: nextIndex.lastActiveChatId || nextIndex.chats[0]?.id || null
      }
    }

    await db.conversation_threads.delete(chatId)
    if (removeTopic && target.origin !== 'main-chat' && target.origin !== 'thread') {
      await removeTopicData(target.topicId)
    }

    const nextRecords = await listCanvasThreadRecords(canvasId)
    const nextPreferredActive = getLastActiveChatId(nextRecords) || nextRecords[0]?.id || null

    if (nextPreferredActive) {
      await db.conversation_threads.update(nextPreferredActive, { lastActiveAt: nowIso() })
    }

    const nextIndex = await CanvasChatService.listChats(canvasId)

    return {
      index: nextIndex,
      activeChatId: nextPreferredActive
    }
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
    const sourceRecords = await listCanvasThreadRecords(sourceCanvasId)
    const duplicatedSource = sourceRecords.filter(
      (source) => source.origin !== 'main-chat' && source.origin !== 'thread'
    )
    if (duplicatedSource.length === 0) {
      return
    }

    await migrateLegacyCanvasChatsIfNeeded(newCanvasId)

    const dispatch = store.dispatch as any

    // Map old chatId -> new chatId for lastActiveChat mapping.
    const mappedChatIds = new Map<string, string>()
    const destRecords: ConversationThreadRecord[] = []

    for (const source of duplicatedSource) {
      const newChatId = uuid()
      mappedChatIds.set(source.id, newChatId)

      const newTopicId = buildCanvasChatTopicId(newCanvasId, newChatId)
      const now = nowIso()

      destRecords.push({
        id: newChatId,
        topicId: newTopicId,
        scope: CANVAS_THREAD_SCOPE,
        canvasId: newCanvasId,
        origin: 'canvas',
        assistantId: source.assistantId,
        name: source.name,
        isNameManuallyEdited: source.isNameManuallyEdited,
        createdAt: now,
        updatedAt: now
      })

      await ensureDexieTopicExists(newTopicId)

      try {
        // Ensure source messages/blocks are present in redux state so the clone thunk can reuse them.
        await dispatch(loadTopicMessagesThunk(source.topicId, true) as any)

        const newTopic: Topic = buildHiddenTopicSkeleton({
          topicId: newTopicId,
          assistantId: source.assistantId,
          name: source.name || 'Canvas Chat'
        })

        // Clone *all* messages (branchPointIndex > len => clones full).
        await dispatch(cloneMessagesToNewTopicThunk(source.topicId, Number.MAX_SAFE_INTEGER, newTopic) as any)
      } catch (error) {
        // Non-fatal: keep metadata + empty topic.
        logger.warn('Failed to duplicate canvas chat topic (non-fatal):', {
          sourceTopicId: source.topicId,
          newTopicId,
          error: (error as Error)?.message
        })
      }
    }

    if (destRecords.length > 0) {
      await db.conversation_threads.bulkPut(destRecords)

      const sourceActiveChatId = getLastActiveChatId(duplicatedSource) || duplicatedSource[0]?.id
      const mappedActiveChatId = sourceActiveChatId ? mappedChatIds.get(sourceActiveChatId) : destRecords[0]?.id
      if (mappedActiveChatId) {
        await db.conversation_threads.update(mappedActiveChatId, { lastActiveAt: nowIso() })
      }
    }
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

    const index = await CanvasChatService.listChats(canvasId)
    if (index.chats.length === 0) {
      const created = await CanvasChatService.createChat({
        canvasId,
        assistantId: defaultAssistantId,
        name: undefined
      })
      const nextIndex = await CanvasChatService.listChats(canvasId)
      return { index: nextIndex, activeChat: created }
    }

    const activeId = index.lastActiveChatId || index.chats[0]?.id
    const active = index.chats.find((chat) => chat.id === activeId) || index.chats[0]
    if (!active) {
      const created = await CanvasChatService.createChat({
        canvasId,
        assistantId: defaultAssistantId,
        name: undefined
      })
      const nextIndex = await CanvasChatService.listChats(canvasId)
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
