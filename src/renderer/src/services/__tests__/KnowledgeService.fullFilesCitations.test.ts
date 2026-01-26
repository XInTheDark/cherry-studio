import type { KnowledgeDocument } from '@renderer/types'
import type { Assistant, KnowledgeBase } from '@renderer/types'
import { FileTypes } from '@renderer/types'
import { MessageBlockType } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let mockState: any

// KnowledgeService reads directly from the renderer redux store. Mock it so we can control KB snapshots.
vi.mock('@renderer/store', () => ({
  default: {
    getState: () => mockState,
    dispatch: vi.fn()
  }
}))

// Full-files injection needs base params and some defaults. Mock the whole AssistantService module
// to avoid pulling in the full dependency graph (which can create circular init in tests).
vi.mock('@renderer/services/AssistantService', () => {
  const defaultAssistantSettings = { contextCount: 10 }

  const createDefaultTopic = (assistantId: string) => ({
    id: 'topic-default',
    assistantId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    name: 'Default Topic',
    messages: [],
    isNameManuallyEdited: false
  })

  const createDefaultAssistant = () => ({
    id: 'assistant-default',
    name: 'Default Assistant',
    prompt: '',
    topics: [createDefaultTopic('assistant-default')],
    type: 'assistant'
  })

  return {
    DEFAULT_ASSISTANT_SETTINGS: defaultAssistantSettings,
    getAssistantSettings: () => defaultAssistantSettings,
    getDefaultAssistant: () => createDefaultAssistant(),
    getDefaultTopic: (assistantId: string) => createDefaultTopic(assistantId),
    getDefaultModel: () => ({ id: 'gpt-4o', provider: 'openai', name: 'gpt-4o', group: 'chat' }),
    getQuickModel: () => null,
    getTranslateModel: () => null,
    getDefaultTranslateAssistant: () => createDefaultAssistant(),
    getAssistantProvider: () => ({}),
    getProviderByModel: () => ({
      name: 'openai',
      apiHost: 'http://api-host.example',
      apiKey: 'test-key',
      id: 'openai'
    }),
    getProviderByModelId: () => ({}),
    getDefaultProvider: () => ({}),
    getAssistantById: () => createDefaultAssistant(),
    getDefaultAssistantSettings: () => defaultAssistantSettings
  }
})

vi.mock('@renderer/aiCore', () => ({
  ModernAiProvider: class ModernAiProvider {
    constructor() {}
    getActualProvider() {
      return { apiHost: 'http://api-host.example', id: 'openai' }
    }
    getApiKey() {
      return 'test-key'
    }
  }
}))

vi.mock('@renderer/aiCore/legacy', () => ({
  default: class LegacyAiProvider {
    constructor() {}
    getBaseURL() {
      return 'http://rerank-host.example'
    }
    getApiKey() {
      return 'test-key'
    }
  }
}))

vi.mock('@renderer/utils', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>
  return {
    ...actual,
    routeToEndpoint: () => ({ baseURL: 'http://api-host.example' })
  }
})

vi.mock('@renderer/utils/provider', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>
  return {
    ...actual,
    isGeminiProvider: () => false,
    isAzureOpenAIProvider: () => false
  }
})

vi.mock('@renderer/config/embedings', () => ({
  getEmbeddingMaxContext: () => undefined
}))

import { KNOWLEDGE_DOCUMENT_COUNT_FULL_FILES } from '@renderer/config/constant'

import { injectUserMessageWithKnowledgeSearchPrompt } from '../KnowledgeService'

describe('KnowledgeService (full-files citations)', () => {
  beforeEach(() => {
    // Reset global api stub per test (tests/renderer.setup.ts only provides api.file by default).
    const existingApi = (globalThis as any).api ?? {}
    vi.stubGlobal('api', {
      ...existingApi,
      knowledgeBase: {
        getDocuments: vi.fn().mockResolvedValue([] as KnowledgeDocument[])
      }
    })
  })

  it('creates citations for full-files mode even when assistant stores a stale KB snapshot (missing uniqueId)', async () => {
    const baseId = 'kb-1'
    const assistantId = 'assistant-1'
    const topicId = 'topic-1'

    const embeddingModel = {
      id: 'text-embedding-3-small',
      provider: 'openai',
      name: 'text-embedding-3-small',
      group: 'embedding'
    } as any

    const file = {
      id: 'file-1',
      name: 'stored.pdf',
      origin_name: 'My File.pdf',
      path: '/tmp/stored.pdf',
      size: 1,
      ext: '.pdf',
      type: FileTypes.DOCUMENT,
      created_at: new Date().toISOString(),
      count: 1
    }

    // Assistant snapshot is stale (missing uniqueId), which previously caused full-files injection to skip all items.
    const assistantSnapshotBase: KnowledgeBase = {
      id: baseId,
      name: 'KB',
      model: embeddingModel,
      items: [
        {
          id: 'note-1',
          type: 'note',
          content: '',
          created_at: Date.now(),
          updated_at: Date.now()
          // uniqueId missing
        } as any,
        {
          id: 'file-item-1',
          type: 'file',
          content: file,
          created_at: Date.now(),
          updated_at: Date.now()
          // uniqueId missing
        } as any
      ],
      created_at: Date.now(),
      updated_at: Date.now(),
      version: 1,
      documentCount: KNOWLEDGE_DOCUMENT_COUNT_FULL_FILES
    }

    // Store has the latest KB (items have uniqueId after processing).
    const storeBase: KnowledgeBase = {
      ...assistantSnapshotBase,
      items: [
        {
          id: 'note-1',
          type: 'note',
          content: '',
          uniqueId: 'note-uid',
          uniqueIds: ['note-uid'],
          remark: 'Note Title',
          created_at: Date.now(),
          updated_at: Date.now()
        } as any,
        {
          id: 'file-item-1',
          type: 'file',
          content: file,
          uniqueId: 'file-uid',
          uniqueIds: ['file-uid'],
          created_at: Date.now(),
          updated_at: Date.now()
        } as any
      ]
    }

    mockState = {
      knowledge: { bases: [storeBase] },
      preprocess: { providers: [] }
    }

    ;(window.api.knowledgeBase.getDocuments as any).mockImplementation(async ({ items }) => {
      // If the stale assistant snapshot was used, items would be empty (no uniqueId).
      expect(items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ uniqueId: 'note-uid' }),
          expect.objectContaining({ uniqueId: 'file-uid' })
        ])
      )

      return [
        {
          uniqueId: 'note-uid',
          type: 'note',
          source: 'note',
          displayName: 'Note Title',
          content: 'Full note content',
          updatedAt: Date.now()
        },
        {
          uniqueId: 'file-uid',
          type: 'file',
          source: file.path,
          displayName: file.origin_name,
          content: 'Full file content',
          updatedAt: Date.now()
        }
      ]
    })

    const blockManager = {
      handleBlockTransition: vi.fn(),
      smartBlockUpdate: vi.fn()
    } as any

    const setCitationBlockId = vi.fn()

    const assistant: Assistant = {
      id: assistantId,
      name: 'Assistant',
      prompt: '',
      type: 'assistant',
      topics: [],
      model: { id: 'gpt-4o', provider: 'openai', name: 'gpt-4o', group: 'chat' } as any,
      knowledge_bases: [assistantSnapshotBase]
    }

    await injectUserMessageWithKnowledgeSearchPrompt({
      modelMessages: [{ role: 'user', content: 'hello' }] as any,
      assistant,
      assistantMsgId: 'assistant-msg-1',
      topicId,
      blockManager,
      setCitationBlockId
    })

    expect(window.api.knowledgeBase.getDocuments).toHaveBeenCalledTimes(1)

    // A citation block should be created so the UI can render "x citations".
    expect(blockManager.handleBlockTransition).toHaveBeenCalledTimes(1)
    const [createdBlock, createdType] = (blockManager.handleBlockTransition as any).mock.calls[0]
    expect(createdType).toBe(MessageBlockType.CITATION)
    expect(createdBlock.type).toBe(MessageBlockType.CITATION)
    expect(createdBlock.knowledge?.length).toBeGreaterThan(0)

    // Sanity: ensure the citations block id is wired through callbacks.
    expect(setCitationBlockId).toHaveBeenCalledWith(createdBlock.id)
  })
})
