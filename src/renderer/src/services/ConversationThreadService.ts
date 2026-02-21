import { loggerService } from '@logger'
import db from '@renderer/databases'
import type { AgentSessionEntity, Assistant, ConversationThreadRecord, Topic } from '@renderer/types'
import { buildAgentSessionTopicId } from '@renderer/utils/agentSession'

const logger = loggerService.withContext('ConversationThreadService')

const HOME_SCOPE = 'home' as const
const SESSION_SCOPE = 'session' as const

function nowIso(): string {
  return new Date().toISOString()
}

function normalizeThreadName(name: string | undefined): string | undefined {
  const trimmed = name?.trim() || ''
  return trimmed.length > 0 ? trimmed : undefined
}

function mapHomeTopicType(topic: Topic): 'chat' | 'session' {
  return topic.type === 'session' ? 'session' : 'chat'
}

function buildHomeThreadRecord(topic: Topic, assistantId: string): ConversationThreadRecord {
  const fallbackNow = nowIso()
  const createdAt = topic.createdAt || fallbackNow
  const updatedAt = topic.updatedAt || createdAt

  return {
    id: topic.id,
    topicId: topic.id,
    scope: HOME_SCOPE,
    assistantId,
    topicType: mapHomeTopicType(topic),
    createdAt,
    updatedAt,
    name: normalizeThreadName(topic.name),
    pinned: !!topic.pinned,
    isNameManuallyEdited: topic.isNameManuallyEdited
  }
}

type SessionThreadLike = Pick<AgentSessionEntity, 'id' | 'name' | 'created_at' | 'updated_at'> & {
  agent_id?: string
}

function buildSessionThreadRecord(agentId: string, session: SessionThreadLike): ConversationThreadRecord {
  const fallbackNow = nowIso()
  const createdAt = session.created_at || fallbackNow
  const updatedAt = session.updated_at || createdAt
  const topicId = buildAgentSessionTopicId(session.id)

  return {
    id: topicId,
    topicId,
    scope: SESSION_SCOPE,
    assistantId: agentId,
    topicType: 'session',
    createdAt,
    updatedAt,
    name: normalizeThreadName(session.name)
  }
}

function uniqueById(records: ConversationThreadRecord[]): ConversationThreadRecord[] {
  const map = new Map<string, ConversationThreadRecord>()
  for (const record of records) {
    map.set(record.id, record)
  }
  return Array.from(map.values())
}

export const ConversationThreadService = {
  buildHomeThreadRecord,
  buildSessionThreadRecord,

  upsertHomeTopic: async ({ assistantId, topic }: { assistantId: string; topic: Topic }): Promise<void> => {
    await db.conversation_threads.put(buildHomeThreadRecord(topic, assistantId))
  },

  upsertHomeTopics: async ({ assistantId, topics }: { assistantId: string; topics: Topic[] }): Promise<void> => {
    if (!topics.length) return
    const records = uniqueById(topics.map((topic) => buildHomeThreadRecord(topic, assistantId)))
    await db.conversation_threads.bulkPut(records)
  },

  replaceHomeTopicsForAssistant: async ({
    assistantId,
    topics
  }: {
    assistantId: string
    topics: Topic[]
  }): Promise<void> => {
    const desiredRecords = uniqueById(topics.map((topic) => buildHomeThreadRecord(topic, assistantId)))
    const desiredIds = new Set(desiredRecords.map((record) => record.id))

    const existing = await db.conversation_threads
      .where('assistantId')
      .equals(assistantId)
      .and((record) => record.scope === HOME_SCOPE)
      .toArray()

    const toDelete = existing.filter((record) => !desiredIds.has(record.id)).map((record) => record.id)

    if (desiredRecords.length > 0) {
      await db.conversation_threads.bulkPut(desiredRecords)
    }

    if (toDelete.length > 0) {
      await db.conversation_threads.bulkDelete(toDelete)
    }
  },

  removeHomeTopic: async (topicId: string): Promise<void> => {
    const existing = await db.conversation_threads.get(topicId)
    if (existing?.scope === HOME_SCOPE) {
      await db.conversation_threads.delete(topicId)
    }
  },

  removeHomeThreadsByAssistantId: async (assistantId: string): Promise<void> => {
    const existing = await db.conversation_threads
      .where('assistantId')
      .equals(assistantId)
      .and((record) => record.scope === HOME_SCOPE)
      .toArray()

    if (existing.length > 0) {
      await db.conversation_threads.bulkDelete(existing.map((record) => record.id))
    }
  },

  touchHomeTopic: async ({ topicId, updatedAt }: { topicId: string; updatedAt?: string }): Promise<boolean> => {
    const record = await db.conversation_threads.get(topicId)
    if (!record || record.scope !== HOME_SCOPE) {
      return false
    }

    await db.conversation_threads.update(topicId, {
      updatedAt: updatedAt || nowIso()
    })

    return true
  },

  reconcileHomeThreads: async (assistants: Assistant[]): Promise<void> => {
    const desiredRecords = uniqueById(
      assistants.flatMap((assistant) =>
        (assistant.topics || []).map((topic) => buildHomeThreadRecord(topic, assistant.id))
      )
    )
    const desiredIds = new Set(desiredRecords.map((record) => record.id))

    const existingHomeRecords = await db.conversation_threads.where('scope').equals(HOME_SCOPE).toArray()
    const staleIds = existingHomeRecords.filter((record) => !desiredIds.has(record.id)).map((record) => record.id)

    await db.transaction('rw', db.conversation_threads, async () => {
      if (desiredRecords.length > 0) {
        await db.conversation_threads.bulkPut(desiredRecords)
      }

      if (staleIds.length > 0) {
        await db.conversation_threads.bulkDelete(staleIds)
      }
    })
  },

  upsertSessionThread: async ({ agentId, session }: { agentId: string; session: SessionThreadLike }): Promise<void> => {
    await db.conversation_threads.put(buildSessionThreadRecord(agentId, session))
  },

  upsertSessionThreads: async ({
    agentId,
    sessions
  }: {
    agentId: string
    sessions: SessionThreadLike[]
  }): Promise<void> => {
    if (!sessions.length) return
    const records = uniqueById(sessions.map((session) => buildSessionThreadRecord(agentId, session)))
    await db.conversation_threads.bulkPut(records)
  },

  reconcileSessionThreadsForAgent: async ({
    agentId,
    sessions
  }: {
    agentId: string
    sessions: SessionThreadLike[]
  }): Promise<void> => {
    const desiredRecords = uniqueById(sessions.map((session) => buildSessionThreadRecord(agentId, session)))
    const desiredIds = new Set(desiredRecords.map((record) => record.id))

    const existingSessionRecords = await db.conversation_threads
      .where('assistantId')
      .equals(agentId)
      .and((record) => record.scope === SESSION_SCOPE)
      .toArray()

    const staleIds = existingSessionRecords.filter((record) => !desiredIds.has(record.id)).map((record) => record.id)

    await db.transaction('rw', db.conversation_threads, async () => {
      if (desiredRecords.length > 0) {
        await db.conversation_threads.bulkPut(desiredRecords)
      }

      if (staleIds.length > 0) {
        await db.conversation_threads.bulkDelete(staleIds)
      }
    })
  },

  removeSessionThread: async (sessionId: string): Promise<void> => {
    const topicId = buildAgentSessionTopicId(sessionId)
    const existing = await db.conversation_threads.get(topicId)
    if (existing?.scope === SESSION_SCOPE) {
      await db.conversation_threads.delete(topicId)
    }
  },

  removeSessionThreadsByAgentId: async (agentId: string): Promise<void> => {
    const existing = await db.conversation_threads
      .where('assistantId')
      .equals(agentId)
      .and((record) => record.scope === SESSION_SCOPE)
      .toArray()

    if (existing.length > 0) {
      await db.conversation_threads.bulkDelete(existing.map((record) => record.id))
    }
  }
}

export async function syncHomeThreadsFromState(assistants: Assistant[]): Promise<void> {
  try {
    await ConversationThreadService.reconcileHomeThreads(assistants)
  } catch (error) {
    logger.warn('Failed to reconcile home conversation threads:', error as Error)
  }
}

export default ConversationThreadService
