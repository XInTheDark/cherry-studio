import { loggerService } from '@logger'

import { joinFsPath, normalizeFsPath } from './canvasHistory/pathUtils'

const logger = loggerService.withContext('CanvasTopicMappingService')

type TopicCanvasMappingEntry = {
  activeCanvasId: string
  updatedAt: string
}

type TopicCanvasMappingIndexV1 = {
  version: 1
  updatedAt: string
  topics: Record<string, TopicCanvasMappingEntry>
}

let appDataPathPromise: Promise<string> | null = null

const lockChains = new Map<string, Promise<unknown>>()

function nowIso(): string {
  return new Date().toISOString()
}

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = lockChains.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  lockChains.set(key, next)
  try {
    return await next
  } finally {
    if (lockChains.get(key) === next) {
      lockChains.delete(key)
    }
  }
}

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

function getMappingFilePath(appDataPath: string): string {
  return joinFsPath(normalizeFsPath(appDataPath), 'Data', 'Canvases', 'topic-canvas-map.json')
}

function getMappingDirPath(appDataPath: string): string {
  return joinFsPath(normalizeFsPath(appDataPath), 'Data', 'Canvases')
}

async function safeReadJson<T>(path: string): Promise<T | null> {
  try {
    const text = await window.api.fs.readText(path)
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

async function ensureDir(path: string): Promise<void> {
  try {
    await window.api.file.mkdir(path)
  } catch (error) {
    logger.debug('Failed to mkdir (ignored):', { path, error: (error as Error)?.message })
  }
}

async function loadOrCreateIndex(appDataPath: string): Promise<TopicCanvasMappingIndexV1> {
  const path = getMappingFilePath(appDataPath)
  const existing = await safeReadJson<TopicCanvasMappingIndexV1>(path)
  if (existing?.version === 1 && existing.topics && typeof existing.topics === 'object') {
    return existing
  }
  return {
    version: 1,
    updatedAt: nowIso(),
    topics: {}
  }
}

async function saveIndex(appDataPath: string, index: TopicCanvasMappingIndexV1): Promise<void> {
  await ensureDir(getMappingDirPath(appDataPath))
  index.updatedAt = nowIso()
  const path = getMappingFilePath(appDataPath)
  await window.api.file.write(path, JSON.stringify(index, null, 2))
}

export const CanvasTopicMappingService = {
  getActiveCanvasId: async (topicId: string): Promise<string | null> => {
    if (!topicId) return null
    const appDataPath = await getAppDataPath()
    const lockKey = `canvas-topic-map:${normalizeFsPath(appDataPath)}`
    return withLock(lockKey, async () => {
      const index = await loadOrCreateIndex(appDataPath)
      return index.topics[topicId]?.activeCanvasId ?? null
    })
  },

  setActiveCanvasId: async ({ topicId, canvasId }: { topicId: string; canvasId: string }): Promise<void> => {
    if (!topicId || !canvasId) return
    const appDataPath = await getAppDataPath()
    const lockKey = `canvas-topic-map:${normalizeFsPath(appDataPath)}`
    await withLock(lockKey, async () => {
      const index = await loadOrCreateIndex(appDataPath)
      index.topics[topicId] = {
        activeCanvasId: canvasId,
        updatedAt: nowIso()
      }
      await saveIndex(appDataPath, index)
    })
  },

  clearActiveCanvas: async (topicId: string): Promise<void> => {
    if (!topicId) return
    const appDataPath = await getAppDataPath()
    const lockKey = `canvas-topic-map:${normalizeFsPath(appDataPath)}`
    await withLock(lockKey, async () => {
      const index = await loadOrCreateIndex(appDataPath)
      if (!index.topics[topicId]) return
      delete index.topics[topicId]
      await saveIndex(appDataPath, index)
    })
  }
}

export default CanvasTopicMappingService
