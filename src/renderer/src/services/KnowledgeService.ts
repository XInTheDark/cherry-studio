import { loggerService } from '@logger'
import type { Span } from '@opentelemetry/api'
import { ModernAiProvider } from '@renderer/aiCore'
import AiProvider from '@renderer/aiCore/legacy'
import { getMessageContent } from '@renderer/aiCore/plugins/searchOrchestrationPlugin'
import {
  DEFAULT_KNOWLEDGE_DOCUMENT_COUNT,
  DEFAULT_KNOWLEDGE_THRESHOLD,
  KNOWLEDGE_DOCUMENT_COUNT_FULL_FILES
} from '@renderer/config/constant'
import { getEmbeddingMaxContext } from '@renderer/config/embedings'
import { REFERENCE_PROMPT } from '@renderer/config/prompts'
import { addSpan, endSpan } from '@renderer/services/SpanManagerService'
import store from '@renderer/store'
import type { Assistant } from '@renderer/types'
import {
  type FileMetadata,
  type KnowledgeBase,
  type KnowledgeBaseParams,
  type KnowledgeDocument,
  type KnowledgeReference,
  type KnowledgeSearchResult,
  SystemProviderIds
} from '@renderer/types'
import type { Chunk } from '@renderer/types/chunk'
import { ChunkType } from '@renderer/types/chunk'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { routeToEndpoint } from '@renderer/utils'
import type { ExtractResults } from '@renderer/utils/extract'
import { createCitationBlock } from '@renderer/utils/messageUtils/create'
import { isAzureOpenAIProvider, isGeminiProvider } from '@renderer/utils/provider'
import type { ModelMessage, UserModelMessage } from 'ai'
import { isEmpty } from 'lodash'

import { getProviderByModel } from './AssistantService'
import FileManager from './FileManager'
import type { BlockManager } from './messageStreaming'

const logger = loggerService.withContext('RendererKnowledgeService')

// Tracks which (topic, assistant, knowledge base) combinations have already injected full-file contents.
// This is in-memory only; reloading the app will allow re-injection.
const fullFilesInjected = new Set<string>()

const truncateText = (text: string, maxLength: number) => {
  if (!text) return ''
  return text.length > maxLength ? text.slice(0, maxLength) + '...' : text
}

export const getKnowledgeBaseParams = (base: KnowledgeBase): KnowledgeBaseParams => {
  const rerankProvider = getProviderByModel(base.rerankModel)
  const aiProvider = new ModernAiProvider(base.model)
  const rerankAiProvider = new AiProvider(rerankProvider)

  // get preprocess provider from store instead of base.preprocessProvider
  const preprocessProvider = store
    .getState()
    .preprocess.providers.find((p) => p.id === base.preprocessProvider?.provider.id)
  const updatedPreprocessProvider = preprocessProvider
    ? {
        type: 'preprocess' as const,
        provider: preprocessProvider
      }
    : base.preprocessProvider

  const actualProvider = aiProvider.getActualProvider()

  let { baseURL } = routeToEndpoint(actualProvider.apiHost)

  const rerankHost = rerankAiProvider.getBaseURL()
  if (isGeminiProvider(actualProvider)) {
    baseURL = baseURL + '/openai'
  } else if (isAzureOpenAIProvider(actualProvider)) {
    baseURL = baseURL + '/v1'
  } else if (actualProvider.id === SystemProviderIds.ollama) {
    // LangChain生态不需要/api结尾的URL
    baseURL = baseURL.replace(/\/api$/, '')
  }

  logger.info(`Knowledge base ${base.name} using baseURL: ${baseURL}`)

  let chunkSize = base.chunkSize
  const maxChunkSize = getEmbeddingMaxContext(base.model.id)

  if (maxChunkSize) {
    if (chunkSize && chunkSize > maxChunkSize) {
      chunkSize = maxChunkSize
    }
    if (!chunkSize && maxChunkSize < 1024) {
      chunkSize = maxChunkSize
    }
  }

  return {
    id: base.id,
    dimensions: base.dimensions,
    embedApiClient: {
      model: base.model.id,
      provider: base.model.provider,
      apiKey: aiProvider.getApiKey() || 'secret',
      baseURL
    },
    chunkSize,
    chunkOverlap: base.chunkOverlap,
    rerankApiClient: {
      model: base.rerankModel?.id || '',
      provider: rerankProvider.name.toLowerCase(),
      apiKey: rerankAiProvider.getApiKey() || 'secret',
      baseURL: rerankHost
    },
    documentCount: base.documentCount,
    preprocessProvider: updatedPreprocessProvider
  }
}

export const getFileFromUrl = async (url: string): Promise<FileMetadata | null> => {
  logger.debug(`getFileFromUrl: ${url}`)
  let fileName = ''

  if (url && url.includes('CherryStudio')) {
    if (url.includes('/Data/Files')) {
      fileName = url.split('/Data/Files/')[1]
    }

    if (url.includes('\\Data\\Files')) {
      fileName = url.split('\\Data\\Files\\')[1]
    }
  }
  logger.debug(`fileName: ${fileName}`)
  if (fileName) {
    const actualFileName = fileName.split(/[/\\]/).pop() || fileName
    logger.debug(`actualFileName: ${actualFileName}`)
    const fileId = actualFileName.split('.')[0]
    const file = await FileManager.getFile(fileId)
    if (file) {
      return file
    }
  }

  return null
}

export const getKnowledgeSourceUrl = async (item: KnowledgeSearchResult & { file: FileMetadata | null }) => {
  if (item.metadata.source.startsWith('http')) {
    return item.metadata.source
  }

  if (item.file) {
    return `[${item.file.origin_name}](http://file/${item.file.name})`
  }

  return item.metadata.source
}

export const searchKnowledgeBase = async (
  query: string,
  base: KnowledgeBase,
  rewrite?: string,
  topicId?: string,
  parentSpanId?: string,
  modelName?: string
): Promise<Array<KnowledgeSearchResult & { file: FileMetadata | null }>> => {
  let currentSpan: Span | undefined = undefined
  try {
    const baseParams = getKnowledgeBaseParams(base)
    const documentCount = base.documentCount || DEFAULT_KNOWLEDGE_DOCUMENT_COUNT
    const threshold = base.threshold || DEFAULT_KNOWLEDGE_THRESHOLD

    if (topicId) {
      currentSpan = addSpan({
        topicId,
        name: `${base.name}-search`,
        inputs: {
          query,
          rewrite,
          base: baseParams
        },
        tag: 'Knowledge',
        parentSpanId,
        modelName
      })
    }

    const searchResults: KnowledgeSearchResult[] = await window.api.knowledgeBase.search(
      {
        search: query || rewrite || '',
        base: baseParams
      },
      currentSpan?.spanContext()
    )

    // 过滤阈值不达标的结果
    const filteredResults = searchResults.filter((item) => item.score >= threshold)

    // 如果有rerank模型，执行重排
    let rerankResults = filteredResults
    if (base.rerankModel && filteredResults.length > 0) {
      rerankResults = await window.api.knowledgeBase.rerank(
        {
          search: rewrite || query,
          base: baseParams,
          results: filteredResults
        },
        currentSpan?.spanContext()
      )
    }

    // 限制文档数量
    const limitedResults = rerankResults.slice(0, documentCount)

    // 处理文件信息
    const result = await Promise.all(
      limitedResults.map(async (item) => {
        const file = await getFileFromUrl(item.metadata.source)
        logger.debug(`Knowledge search item: ${JSON.stringify(item)} File: ${JSON.stringify(file)}`)
        return { ...item, file }
      })
    )
    if (topicId) {
      endSpan({
        topicId,
        outputs: result,
        span: currentSpan,
        modelName
      })
    }
    return result
  } catch (error) {
    logger.error(`Error searching knowledge base ${base.name}:`, error as Error)
    if (topicId) {
      endSpan({
        topicId,
        error: error instanceof Error ? error : new Error(String(error)),
        span: currentSpan,
        modelName
      })
    }
    throw error
  }
}

export const processKnowledgeSearch = async (
  extractResults: ExtractResults,
  knowledgeBaseIds: string[] | undefined,
  topicId: string,
  parentSpanId?: string,
  modelName?: string
): Promise<KnowledgeReference[]> => {
  if (
    !extractResults.knowledge?.question ||
    extractResults.knowledge.question.length === 0 ||
    isEmpty(knowledgeBaseIds)
  ) {
    logger.info('No valid question found in extractResults.knowledge')
    return []
  }

  const questions = extractResults.knowledge.question
  const rewrite = extractResults.knowledge.rewrite

  const bases = store.getState().knowledge.bases.filter((kb) => knowledgeBaseIds?.includes(kb.id))
  if (!bases || bases.length === 0) {
    logger.info('Skipping knowledge search: No matching knowledge bases found.')
    return []
  }

  const span = addSpan({
    topicId,
    name: 'knowledgeSearch',
    inputs: {
      questions,
      rewrite,
      knowledgeBaseIds: knowledgeBaseIds
    },
    tag: 'Knowledge',
    parentSpanId,
    modelName
  })

  // 为每个知识库执行多问题搜索
  const baseSearchPromises = bases.map(async (base) => {
    // 为每个问题搜索并合并结果
    const allResults = await Promise.all(
      questions.map((question) =>
        searchKnowledgeBase(question, base, rewrite, topicId, span?.spanContext().spanId, modelName)
      )
    )

    // 合并结果并去重
    const flatResults = allResults.flat()
    const uniqueResults = Array.from(
      new Map(flatResults.map((item) => [item.metadata.uniqueId || item.pageContent, item])).values()
    ).sort((a, b) => b.score - a.score)

    // 转换为引用格式
    const result = await Promise.all(
      uniqueResults.map(
        async (item, index) =>
          ({
            id: index + 1,
            content: item.pageContent,
            sourceUrl: await getKnowledgeSourceUrl(item),
            metadata: item.metadata,
            type: 'file'
          }) as KnowledgeReference
      )
    )
    return result
  })

  // 汇总所有知识库的结果
  const resultsPerBase = await Promise.all(baseSearchPromises)
  const allReferencesRaw = resultsPerBase.flat().filter((ref): ref is KnowledgeReference => !!ref)
  endSpan({
    topicId,
    outputs: resultsPerBase,
    span,
    modelName
  })

  // 重新为引用分配ID
  return allReferencesRaw.map((ref, index) => ({
    ...ref,
    id: index + 1
  }))
}

/**
 * 处理知识库搜索结果中的引用
 * @param references 知识库引用
 * @param onChunkReceived Chunk接收回调
 */
export function processKnowledgeReferences(
  references: KnowledgeReference[] | undefined,
  onChunkReceived: (chunk: Chunk) => void
) {
  if (!references || references.length === 0) {
    return
  }

  for (const ref of references) {
    const { metadata } = ref
    if (!metadata?.source) {
      continue
    }

    switch (metadata.type) {
      case 'video': {
        onChunkReceived({
          type: ChunkType.VIDEO_SEARCHED,
          video: {
            type: 'path',
            content: metadata.source
          },
          metadata
        })
        break
      }
    }
  }
}

export type KnowledgeInjectionResult = {
  /**
   * System prompt prefix that should be prepended for this request.
   * This is used for "Full files" mode and is intentionally injected only once per (topic, assistant, KB).
   */
  systemPromptPrefix?: string
}

const buildFullFilesInjectionKey = (topicId: string, assistantId: string, baseId: string) =>
  `${topicId}:${assistantId}:${baseId}`

const buildFullFilesSystemPromptSection = ({
  baseName,
  documents
}: {
  baseName: string
  documents: Array<{ title: string; content: string }>
}) => {
  const header =
    `# Knowledge Base: ${baseName} (Full files)\n\n` +
    `The following documents are provided in full. Use them as context when answering the user.\n\n`

  const body = documents
    .map((doc, idx) => {
      return `---\n` + `Document ${idx + 1}: ${doc.title}\n` + `---\n` + `${doc.content}\n`
    })
    .join('\n')

  return header + body
}

const buildFullFilesKnowledgeContext = async ({
  assistant,
  bases,
  topicId
}: {
  assistant: Assistant
  bases: KnowledgeBase[]
  topicId: string
}): Promise<{ systemPromptPrefix: string; references: KnowledgeReference[] }> => {
  const references: KnowledgeReference[] = []
  const systemSections: string[] = []

  for (const base of bases) {
    const injectionKey = buildFullFilesInjectionKey(topicId, assistant.id, base.id)
    if (fullFilesInjected.has(injectionKey)) {
      continue
    }

    const items = base.items.filter((item) => (item.type === 'file' || item.type === 'note') && !!item.uniqueId)
    if (items.length === 0) {
      continue
    }

    const baseParams = getKnowledgeBaseParams(base)

    let docs: KnowledgeDocument[] = []
    try {
      docs = await window.api.knowledgeBase.getDocuments({ base: baseParams, items }, undefined)
    } catch (err) {
      logger.error('Failed to fetch knowledge documents for full-files mode', { baseId: base.id, err })
      continue
    }

    if (docs.length === 0) {
      continue
    }

    // Mark as injected only if we have actual content to inject.
    fullFilesInjected.add(injectionKey)

    const itemByUniqueId = new Map(items.map((i) => [i.uniqueId as string, i]))

    const systemDocs: Array<{ title: string; content: string }> = []

    for (const doc of docs) {
      const item = itemByUniqueId.get(doc.uniqueId)
      if (!item) continue

      if (item.type === 'file') {
        const file = item.content as FileMetadata
        const title = file.origin_name || doc.displayName || file.name
        systemDocs.push({ title, content: doc.content })

        references.push({
          id: 0, // will be renumbered later
          type: 'file',
          content: truncateText(doc.content, 400),
          sourceUrl: `[${file.origin_name}](http://file/${file.name})`,
          metadata: {
            knowledgeFullFiles: true,
            knowledgeBaseId: base.id,
            knowledgeBaseName: base.name
          },
          file
        })
      } else if (item.type === 'note') {
        const title = item.remark || doc.displayName || 'Note'
        systemDocs.push({ title, content: doc.content })

        references.push({
          id: 0, // will be renumbered later
          type: 'note',
          content: truncateText(doc.content, 400),
          sourceUrl: typeof doc.source === 'string' && doc.source.startsWith('http') ? doc.source : '',
          metadata: {
            knowledgeFullFiles: true,
            knowledgeBaseId: base.id,
            knowledgeBaseName: base.name
          }
        })
      }
    }

    if (systemDocs.length > 0) {
      systemSections.push(buildFullFilesSystemPromptSection({ baseName: base.name, documents: systemDocs }))
    }
  }

  return { systemPromptPrefix: systemSections.join('\n\n'), references }
}

export const injectUserMessageWithKnowledgeSearchPrompt = async ({
  modelMessages,
  assistant,
  assistantMsgId,
  topicId,
  blockManager,
  setCitationBlockId
}: {
  modelMessages: ModelMessage[]
  assistant: Assistant
  assistantMsgId: string
  topicId?: string
  blockManager: BlockManager
  setCitationBlockId: (blockId: string) => void
}): Promise<KnowledgeInjectionResult> => {
  if (!assistant.knowledge_bases?.length || modelMessages.length === 0) {
    return {}
  }

  const lastUserMessage = modelMessages[modelMessages.length - 1]
  if (lastUserMessage.role !== 'user') {
    return {}
  }

  if (!topicId) {
    logger.warn('Knowledge injection skipped: missing topicId')
    return {}
  }

  const fullFilesBases = assistant.knowledge_bases.filter(
    (b) => (b.documentCount ?? DEFAULT_KNOWLEDGE_DOCUMENT_COUNT) === KNOWLEDGE_DOCUMENT_COUNT_FULL_FILES
  )
  const chunkBases = assistant.knowledge_bases.filter(
    (b) => (b.documentCount ?? DEFAULT_KNOWLEDGE_DOCUMENT_COUNT) !== KNOWLEDGE_DOCUMENT_COUNT_FULL_FILES
  )

  const question = getMessageContent(lastUserMessage) || ''

  let chunkReferences: KnowledgeReference[] = []
  if (chunkBases.length > 0) {
    chunkReferences = await processKnowledgeSearch(
      {
        knowledge: {
          question: [question],
          rewrite: ''
        }
      },
      chunkBases.map((b) => b.id),
      topicId
    )
  }

  const fullFilesResult =
    fullFilesBases.length > 0
      ? await buildFullFilesKnowledgeContext({ assistant, bases: fullFilesBases, topicId })
      : { systemPromptPrefix: '', references: [] }

  const combinedReferences = [...chunkReferences, ...fullFilesResult.references].map((ref, index) => ({
    ...ref,
    id: index + 1
  }))

  if (combinedReferences.length > 0) {
    await createKnowledgeReferencesBlock({
      assistantMsgId,
      knowledgeReferences: combinedReferences,
      blockManager,
      setCitationBlockId
    })
  }

  // Only rewrite the user message with REFERENCE_PROMPT when chunk-based retrieval is used.
  // For full-files-only mode, the full content is injected into the system prompt, and wrapping
  // the user message with snippet-only references can accidentally bias the model to ignore the full context.
  if (chunkReferences.length > 0) {
    const referencesJson = JSON.stringify(combinedReferences, null, 2)
    const knowledgeSearchPrompt = REFERENCE_PROMPT.replace('{question}', question).replace(
      '{references}',
      referencesJson
    )

    if (typeof lastUserMessage.content === 'string') {
      lastUserMessage.content = knowledgeSearchPrompt
    } else if (Array.isArray(lastUserMessage.content)) {
      const textPart = lastUserMessage.content.find((part) => part.type === 'text')
      if (textPart) {
        textPart.text = knowledgeSearchPrompt
      } else {
        lastUserMessage.content.push({ type: 'text', text: knowledgeSearchPrompt })
      }
    }
  }

  return {
    systemPromptPrefix: fullFilesResult.systemPromptPrefix || undefined
  }
}

export const getKnowledgeReferences = async ({
  assistant,
  lastUserMessage,
  topicId
}: {
  assistant: Assistant
  lastUserMessage: UserModelMessage
  topicId?: string
}) => {
  // 如果助手没有知识库，返回空字符串
  if (!assistant || isEmpty(assistant.knowledge_bases)) {
    return []
  }

  // 获取知识库ID
  const knowledgeBaseIds = assistant.knowledge_bases?.map((base) => base.id)

  // 获取用户消息内容
  const question = getMessageContent(lastUserMessage) || ''

  // 获取知识库引用
  const knowledgeReferences = await processKnowledgeSearch(
    {
      knowledge: {
        question: [question],
        rewrite: ''
      }
    },
    knowledgeBaseIds,
    topicId!
  )

  // 返回提示词
  return knowledgeReferences
}

export const createKnowledgeReferencesBlock = async ({
  assistantMsgId,
  knowledgeReferences,
  blockManager,
  setCitationBlockId
}: {
  assistantMsgId: string
  knowledgeReferences: KnowledgeReference[]
  blockManager: BlockManager
  setCitationBlockId: (blockId: string) => void
}) => {
  // 创建引用块
  const citationBlock = createCitationBlock(
    assistantMsgId,
    { knowledge: knowledgeReferences },
    { status: MessageBlockStatus.SUCCESS }
  )

  // 处理引用块
  blockManager.handleBlockTransition(citationBlock, MessageBlockType.CITATION)

  // 设置引用块ID
  setCitationBlockId(citationBlock.id)

  // 返回引用块
  return citationBlock
}
