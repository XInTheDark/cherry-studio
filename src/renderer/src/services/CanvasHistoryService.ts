import { loggerService } from '@logger'
import { uuid } from '@renderer/utils'

import {
  basenameFsPath,
  dirnameFsPath,
  joinFsPath,
  normalizeFsPath,
  rewritePathPrefix,
  splitFileExt,
  toNotesRelativePath
} from './canvasHistory/pathUtils'

const logger = loggerService.withContext('CanvasHistoryService')

const CANVAS_ROOT_DIR_NAME = '.cherry-canvas'
const CANVAS_MAPPING_FILE_NAME = 'index.json'
const CANVAS_HISTORY_DIR_NAME = 'history'
const CANVAS_VERSIONS_DIR_NAME = 'versions'

export type CanvasActor = 'human' | 'assistant' | 'system'

export type CanvasMappingEntryV1 = {
  canvasId: string
  createdAt: string
  updatedAt: string
}

export type CanvasMappingIndexV1 = {
  version: 1
  updatedAt: string
  items: Record<string, CanvasMappingEntryV1>
}

export type CanvasVersionEntryV1 = {
  id: string
  createdAt: string
  actor: CanvasActor
  reason?: string
  baseSha256?: string
  nextSha256?: string
  byteSize?: number
  gzipByteSize?: number
}

export type CanvasHistoryIndexV1 = {
  version: 1
  canvasId: string
  updatedAt: string
  versions: CanvasVersionEntryV1[]
}

type CommitVersionParams = {
  notesPath: string
  filePath: string
  content: string
  actor: CanvasActor
  reason?: string
  /**
   * When false (default), if the content hash matches the latest committed version,
   * no new version is created.
   */
  force?: boolean
}

type CommitVersionResult =
  | { created: true; canvasId: string; version: CanvasVersionEntryV1 }
  | { created: false; canvasId: string; version: null }

function nowIso(): string {
  return new Date().toISOString()
}

async function sha256Hex(text: string): Promise<string> {
  // Use WebCrypto (available in Electron renderer).
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function byteSizeUtf8(text: string): number {
  return new TextEncoder().encode(text).byteLength
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
  const text = JSON.stringify(data, null, 2)
  await window.api.file.write(path, text)
}

async function ensureDir(path: string): Promise<void> {
  try {
    await window.api.file.mkdir(path)
  } catch (error) {
    // mkdir is recursive; still keep safe if underlying impl changes.
    logger.debug('Failed to mkdir (ignored):', { path, error: (error as Error)?.message })
  }
}

const lockChains = new Map<string, Promise<unknown>>()

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

function getCanvasRootDir(notesPath: string): string {
  return joinFsPath(normalizeFsPath(notesPath), CANVAS_ROOT_DIR_NAME)
}

function getMappingIndexPath(notesPath: string): string {
  return joinFsPath(getCanvasRootDir(notesPath), CANVAS_MAPPING_FILE_NAME)
}

function getCanvasHistoryDir(notesPath: string, canvasId: string): string {
  return joinFsPath(getCanvasRootDir(notesPath), CANVAS_HISTORY_DIR_NAME, canvasId)
}

function getCanvasHistoryIndexPath(notesPath: string, canvasId: string): string {
  return joinFsPath(getCanvasHistoryDir(notesPath, canvasId), CANVAS_MAPPING_FILE_NAME)
}

function getCanvasVersionsDir(notesPath: string, canvasId: string): string {
  return joinFsPath(getCanvasHistoryDir(notesPath, canvasId), CANVAS_VERSIONS_DIR_NAME)
}

function getCanvasVersionBlobPath(notesPath: string, canvasId: string, versionId: string): string {
  return joinFsPath(getCanvasVersionsDir(notesPath, canvasId), `${versionId}.gz`)
}

async function getAvailableCopyPath({
  filePath,
  maxAttempts = 100
}: {
  filePath: string
  maxAttempts?: number
}): Promise<string> {
  const dir = dirnameFsPath(filePath)
  const base = basenameFsPath(filePath)
  const { name, ext } = splitFileExt(base)
  const finalExt = ext || '.md'

  for (let i = 1; i <= maxAttempts; i += 1) {
    const candidateName = i === 1 ? `${name} (copy)` : `${name} (copy ${i})`
    const candidatePath = joinFsPath(dir, `${candidateName}${finalExt}`)
    const exists = await window.api.file.get(candidatePath)
    if (!exists) {
      return candidatePath
    }
  }

  throw new Error(`Failed to find an available duplicate name for: ${filePath}`)
}

async function loadOrCreateMappingIndex(notesPath: string): Promise<CanvasMappingIndexV1> {
  const mappingPath = getMappingIndexPath(notesPath)
  const existing = await safeReadJson<CanvasMappingIndexV1>(mappingPath)
  if (existing?.version === 1 && existing.items && typeof existing.items === 'object') {
    return existing
  }
  return { version: 1, updatedAt: nowIso(), items: {} }
}

async function saveMappingIndex(notesPath: string, index: CanvasMappingIndexV1): Promise<void> {
  index.updatedAt = nowIso()
  await ensureDir(getCanvasRootDir(notesPath))
  await writeJson(getMappingIndexPath(notesPath), index)
}

async function loadOrCreateHistoryIndex(notesPath: string, canvasId: string): Promise<CanvasHistoryIndexV1> {
  const historyIndexPath = getCanvasHistoryIndexPath(notesPath, canvasId)
  const existing = await safeReadJson<CanvasHistoryIndexV1>(historyIndexPath)
  if (existing?.version === 1 && existing.canvasId === canvasId && Array.isArray(existing.versions)) {
    return existing
  }
  return { version: 1, canvasId, updatedAt: nowIso(), versions: [] }
}

async function saveHistoryIndex(notesPath: string, canvasId: string, index: CanvasHistoryIndexV1): Promise<void> {
  index.updatedAt = nowIso()
  await ensureDir(getCanvasVersionsDir(notesPath, canvasId))
  await writeJson(getCanvasHistoryIndexPath(notesPath, canvasId), index)
}

async function getOrCreateCanvasId(
  notesPath: string,
  filePath: string
): Promise<{ canvasId: string; relPath: string }> {
  const rel = toNotesRelativePath(notesPath, filePath)
  if (!rel) {
    throw new Error(`File is not inside notesPath: ${filePath}`)
  }

  const mappingLockKey = `canvas-mapping:${normalizeFsPath(notesPath)}`
  return withLock(mappingLockKey, async () => {
    const index = await loadOrCreateMappingIndex(notesPath)
    const existing = index.items[rel]
    if (existing?.canvasId) {
      // Touch updatedAt for the mapping entry but keep file-level timestamps stable.
      existing.updatedAt = nowIso()
      await saveMappingIndex(notesPath, index)
      return { canvasId: existing.canvasId, relPath: rel }
    }

    const now = nowIso()
    const canvasId = uuid()
    index.items[rel] = { canvasId, createdAt: now, updatedAt: now }
    await saveMappingIndex(notesPath, index)
    return { canvasId, relPath: rel }
  })
}

async function touchMappingUpdatedAt(notesPath: string, relPath: string): Promise<void> {
  const mappingLockKey = `canvas-mapping:${normalizeFsPath(notesPath)}`
  await withLock(mappingLockKey, async () => {
    const index = await loadOrCreateMappingIndex(notesPath)
    const entry = index.items[relPath]
    if (!entry) return
    entry.updatedAt = nowIso()
    await saveMappingIndex(notesPath, index)
  })
}

export const CanvasHistoryService = {
  /**
   * Create a version snapshot for the given canvas file.
   */
  commitVersion: async (params: CommitVersionParams): Promise<CommitVersionResult> => {
    const { notesPath, filePath, content, actor, reason, force = false } = params

    const { canvasId, relPath } = await getOrCreateCanvasId(notesPath, filePath)
    const canvasLockKey = `canvas-history:${canvasId}`

    return withLock(canvasLockKey, async () => {
      await ensureDir(getCanvasVersionsDir(notesPath, canvasId))

      const historyIndex = await loadOrCreateHistoryIndex(notesPath, canvasId)
      const last = historyIndex.versions.at(-1)
      const baseSha = last?.nextSha256

      const nextSha = await sha256Hex(content)
      if (!force && baseSha && baseSha === nextSha) {
        return { created: false as const, canvasId, version: null }
      }

      const gzip = await window.api.zip.compress(content)
      const versionId = uuid()
      const blobPath = getCanvasVersionBlobPath(notesPath, canvasId, versionId)

      await window.api.file.write(blobPath, gzip)

      const entry: CanvasVersionEntryV1 = {
        id: versionId,
        createdAt: nowIso(),
        actor,
        reason,
        baseSha256: baseSha,
        nextSha256: nextSha,
        byteSize: byteSizeUtf8(content),
        gzipByteSize: (gzip as unknown as Uint8Array).byteLength ?? (gzip as unknown as any)?.length
      }

      historyIndex.versions.push(entry)
      await saveHistoryIndex(notesPath, canvasId, historyIndex)
      await touchMappingUpdatedAt(notesPath, relPath)

      return { created: true as const, canvasId, version: entry }
    })
  },

  /**
   * List versions for the canvas file (empty list if none).
   */
  listVersions: async ({
    notesPath,
    filePath
  }: {
    notesPath: string
    filePath: string
  }): Promise<{ canvasId: string; versions: CanvasVersionEntryV1[] }> => {
    const { canvasId } = await getOrCreateCanvasId(notesPath, filePath)
    const history = await loadOrCreateHistoryIndex(notesPath, canvasId)
    return { canvasId, versions: history.versions }
  },

  /**
   * Restore a version snapshot into the markdown file.
   * This overwrites the file on disk and (optionally) creates a new version entry to represent the restore action.
   */
  restoreVersion: async ({
    notesPath,
    filePath,
    versionId
  }: {
    notesPath: string
    filePath: string
    versionId: string
  }): Promise<{ canvasId: string; restored: boolean }> => {
    const { canvasId } = await getOrCreateCanvasId(notesPath, filePath)
    const blobPath = getCanvasVersionBlobPath(notesPath, canvasId, versionId)

    const gzip = await window.api.fs.read(blobPath)
    const content = await window.api.zip.decompress(gzip as unknown as Buffer)

    await window.api.file.write(filePath, content)

    // Record restore action as a new version for easier "undo restore" UX.
    try {
      await CanvasHistoryService.commitVersion({
        notesPath,
        filePath,
        content,
        actor: 'human',
        reason: `restore ${versionId}`,
        force: true
      })
    } catch (error) {
      logger.warn('Failed to record restore action in history (non-fatal):', error as Error)
    }

    return { canvasId, restored: true }
  },

  /**
   * Read a version snapshot's plain text content (decompressing the gzip blob).
   */
  readVersionContent: async ({
    notesPath,
    filePath,
    versionId
  }: {
    notesPath: string
    filePath: string
    versionId: string
  }): Promise<{ canvasId: string; content: string }> => {
    const { canvasId } = await getOrCreateCanvasId(notesPath, filePath)
    const blobPath = getCanvasVersionBlobPath(notesPath, canvasId, versionId)

    const gzip = await window.api.fs.read(blobPath)
    const content = await window.api.zip.decompress(gzip as unknown as Buffer)
    return { canvasId, content }
  },

  /**
   * Deep-duplicate a canvas file, including on-disk version history (portable).
   *
   * Today we copy:
   * - markdown file contents
   * - `.cherry-canvas/index.json` mapping entry (new canvasId)
   * - `.cherry-canvas/history/<canvasId>` history directory (new canvasId, same versions)
   *
   * Future: extend to copy per-canvas chat/topic stores.
   */
  duplicateCanvas: async ({
    notesPath,
    filePath,
    content
  }: {
    notesPath: string
    filePath: string
    content?: string
  }): Promise<{ sourceCanvasId: string; newCanvasId: string; newFilePath: string }> => {
    const nextContent = content ?? (await window.api.fs.readText(filePath))

    // Create a "safety" snapshot right before we duplicate so fast edits aren't lost in history.
    const commit = await CanvasHistoryService.commitVersion({
      notesPath,
      filePath,
      content: nextContent,
      actor: 'system',
      reason: 'duplicate canvas (pre-copy snapshot)'
    })

    const sourceCanvasId = commit.canvasId
    const newFilePath = await getAvailableCopyPath({ filePath })

    // Copy the file content.
    await window.api.file.write(newFilePath, nextContent)

    // Create a new canvasId mapping entry for the duplicate.
    const { canvasId: newCanvasId } = await getOrCreateCanvasId(notesPath, newFilePath)

    // Copy history folder and rewrite canvasId in its index.json.
    const sourceHistoryDir = getCanvasHistoryDir(notesPath, sourceCanvasId)
    const newHistoryDir = getCanvasHistoryDir(notesPath, newCanvasId)

    const copyResult = await window.api.copy(sourceHistoryDir, newHistoryDir, [])
    if (!copyResult?.success) {
      throw new Error(copyResult?.error || 'Failed to copy canvas history')
    }

    // Rewrite the copied index.json to the new canvasId so the loader recognizes it.
    const sourceHistoryIndex = await loadOrCreateHistoryIndex(notesPath, sourceCanvasId)
    await saveHistoryIndex(notesPath, newCanvasId, {
      ...sourceHistoryIndex,
      canvasId: newCanvasId
    })

    return { sourceCanvasId, newCanvasId, newFilePath }
  },

  /**
   * Update mapping index when a canvas file (or folder) is renamed/moved inside the notes directory.
   * For folders, pass `deep: true` to rewrite all descendant entries.
   */
  rewriteMappingPath: async ({
    notesPath,
    oldPath,
    newPath,
    deep
  }: {
    notesPath: string
    oldPath: string
    newPath: string
    deep: boolean
  }): Promise<void> => {
    const oldRel = toNotesRelativePath(notesPath, oldPath)
    const newRel = toNotesRelativePath(notesPath, newPath)
    if (!oldRel || !newRel) return

    const mappingLockKey = `canvas-mapping:${normalizeFsPath(notesPath)}`
    await withLock(mappingLockKey, async () => {
      const index = await loadOrCreateMappingIndex(notesPath)
      const items = index.items
      const next: Record<string, CanvasMappingEntryV1> = {}

      for (const [key, value] of Object.entries(items)) {
        if (key === oldRel) {
          next[newRel] = value
          continue
        }
        if (deep) {
          const rewritten = rewritePathPrefix(key, oldRel, newRel)
          if (rewritten) {
            next[rewritten] = value
            continue
          }
        }
        next[key] = value
      }

      index.items = next
      await saveMappingIndex(notesPath, index)
    })
  }
}

export default CanvasHistoryService
